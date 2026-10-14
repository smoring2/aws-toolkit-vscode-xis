/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Sha256 } from '@aws-crypto/sha256-js'
import { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@aws-sdk/types'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'
import { getLogger } from './logger'

/**
 * Client for AWS services which use the "AWS JSON" protocol but have no public AWS SDK v3
 * client package. The service API is described by the same `service-2.json` model that the
 * AWS SDK v2 loaded at runtime (`new Service({ apiConfig })`).
 *
 * Only the pieces the Toolkit needs are implemented: AWS JSON requests (POST `/` with an
 * `x-amz-target` header), SigV4 or bearer token authentication, retries and model-driven
 * timestamp conversion.
 */

interface ShapeRef {
    shape: string
}

interface Shape {
    type: string
    members?: Record<string, ShapeRef>
    member?: ShapeRef
    value?: ShapeRef
    key?: ShapeRef
}

export interface ServiceModel {
    metadata: {
        targetPrefix: string
        signingName?: string
        endpointPrefix: string
        jsonVersion?: string
    }
    operations: Record<string, { name?: string; input?: ShapeRef; output?: ShapeRef }>
    shapes: Record<string, Shape>
}

/** Response metadata attached to every response, mirroring the AWS SDK v3 shape. */
export interface ResponseMetadataBearer {
    $metadata: {
        requestId?: string
        httpStatusCode?: number
        /** Value of the `x-amzn-sessionid` response header, when the service sends one. */
        sessionId?: string
    }
}

export interface AwsJsonClientConfig {
    readonly endpoint: string
    readonly region: string
    /** Credentials for SigV4 signing. Omit when using {@link bearerToken}. */
    readonly credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider
    /** Bearer token, for services which use token-based authentication. */
    readonly bearerToken?: string
    /** Number of retries (excluding the initial attempt). Defaults to 3, as in the AWS SDK. */
    readonly maxRetries?: number
    /** Headers added to every request. */
    readonly headers?: Record<string, string>
    /** Headers added to the request of a specific operation (keyed by operation name). */
    readonly operationHeaders?: Record<string, Record<string, string>>
    /** Called for failed requests, to decide whether the request should be retried. */
    readonly shouldRetry?: (error: ServiceError) => Promise<boolean> | boolean
}

export class ServiceError extends Error {
    public constructor(
        public override readonly name: string,
        message: string,
        /** Error code, as named by the AWS SDK v2. */
        public readonly code: string,
        public readonly statusCode: number | undefined,
        public readonly $metadata: ResponseMetadataBearer['$metadata'],
        public readonly retryable: boolean
    ) {
        super(message)
    }
}

const defaultMaxRetries = 3

function toEpochSeconds(date: Date): number {
    return Math.round(date.getTime() / 1000)
}

/** Serializes a request, converting `Date` values to the epoch seconds used by AWS JSON. */
function serialize(value: unknown): unknown {
    if (value instanceof Date) {
        return toEpochSeconds(value)
    }
    if (Array.isArray(value)) {
        return value.map(serialize)
    }
    if (value !== null && typeof value === 'object') {
        const result: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(value)) {
            if (v !== undefined) {
                result[k] = serialize(v)
            }
        }
        return result
    }
    return value
}

/** Converts timestamp members of a response into `Date`, as described by the service model. */
function deserialize(model: ServiceModel, shapeName: string | undefined, value: unknown): unknown {
    if (value === undefined || value === null || shapeName === undefined) {
        return value
    }

    const shape = model.shapes[shapeName]
    if (!shape) {
        return value
    }

    switch (shape.type) {
        case 'timestamp':
            return typeof value === 'number' ? new Date(value * 1000) : new Date(value as string)
        case 'list':
            return Array.isArray(value) ? value.map((v) => deserialize(model, shape.member?.shape, v)) : value
        case 'map': {
            if (typeof value !== 'object') {
                return value
            }
            const mapped: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(value as object)) {
                mapped[k] = deserialize(model, shape.value?.shape, v)
            }
            return mapped
        }
        case 'structure': {
            if (typeof value !== 'object') {
                return value
            }
            const result: Record<string, unknown> = { ...(value as object) }
            for (const [k, v] of Object.entries(value as object)) {
                result[k] = deserialize(model, shape.members?.[k]?.shape, v)
            }
            return result
        }
        default:
            return value
    }
}

function isRetryable(statusCode: number | undefined, code: string): boolean {
    if (statusCode !== undefined && (statusCode === 429 || statusCode >= 500)) {
        return true
    }

    return ['ThrottlingException', 'TooManyRequestsException', 'RequestTimeout', 'RequestTimeoutException'].includes(
        code
    )
}

function toOperationName(operation: string): string {
    return operation.charAt(0).toUpperCase() + operation.slice(1)
}

async function toServiceError(response: Response): Promise<ServiceError> {
    const text = await response.text()
    let body: Record<string, any> = {}
    try {
        body = text ? JSON.parse(text) : {}
    } catch {
        // Not JSON, fall through with the raw text as the message.
    }

    const errorType = response.headers.get('x-amzn-errortype') ?? body.__type ?? body.code ?? 'UnknownError'
    const code = String(errorType).split('#').pop()!.split(':')[0]
    const message = body.message ?? body.Message ?? text ?? response.statusText
    const metadata = {
        requestId: response.headers.get('x-amzn-requestid') ?? undefined,
        httpStatusCode: response.status,
    }

    return new ServiceError(code, message, code, response.status, metadata, isRetryable(response.status, code))
}

/**
 * Creates a client for the given service model.
 *
 * The returned object has one method per model operation, which sends the request and
 * resolves with the response (including `$metadata`).
 */
export function createAwsJsonClient<T extends object>(model: ServiceModel, config: AwsJsonClientConfig): T {
    const operations = new Map<string, string>()
    for (const operation of Object.keys(model.operations)) {
        // Model operations are PascalCase while the client methods are camelCase.
        operations.set(operation.charAt(0).toLowerCase() + operation.slice(1), operation)
    }

    const signer = config.credentials
        ? new SignatureV4({
              credentials: config.credentials,
              region: config.region,
              service: model.metadata.signingName ?? model.metadata.endpointPrefix,
              sha256: Sha256,
          })
        : undefined

    const send = async (operation: string, input: object = {}) => {
        const url = new URL(config.endpoint)
        const jsonVersion = model.metadata.jsonVersion ?? '1.0'
        const body = JSON.stringify(serialize(input))
        const maxRetries = config.maxRetries ?? defaultMaxRetries

        const headers: Record<string, string> = {
            host: url.host,
            'content-type': `application/x-amz-json-${jsonVersion}`,
            'x-amz-target': `${model.metadata.targetPrefix}.${toOperationName(operation)}`,
            ...config.headers,
            ...config.operationHeaders?.[operation],
        }

        if (config.bearerToken !== undefined) {
            headers['Authorization'] = `Bearer ${config.bearerToken}`
        }

        for (let attempt = 0; ; attempt++) {
            const requestHeaders = signer
                ? (
                      await signer.sign(
                          new HttpRequest({
                              method: 'POST',
                              protocol: url.protocol,
                              hostname: url.hostname,
                              port: url.port === '' ? undefined : Number(url.port),
                              path: url.pathname,
                              headers: headers,
                              body: body,
                          })
                      )
                  ).headers
                : headers

            const response = await fetch(url.toString(), {
                method: 'POST',
                headers: requestHeaders as Record<string, string>,
                body: body,
            })

            if (response.ok) {
                const text = await response.text()
                const output = text ? JSON.parse(text) : {}

                return {
                    ...(deserialize(model, model.operations[toOperationName(operation)]?.output?.shape, output) as
                        | object
                        | undefined),
                    $metadata: {
                        requestId: response.headers.get('x-amzn-requestid') ?? undefined,
                        httpStatusCode: response.status,
                        sessionId: response.headers.get('x-amzn-sessionid') ?? undefined,
                    },
                }
            }

            const error = await toServiceError(response)
            const retry = error.retryable || (await config.shouldRetry?.(error)) === true

            if (!retry || attempt >= maxRetries) {
                throw error
            }

            getLogger().debug(
                'awsJsonClient: retrying %s after error "%s" (attempt %d)',
                operation,
                error.name,
                attempt + 1
            )
            await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt))
        }
    }

    const client: Record<string, unknown> = {}
    for (const [method, operation] of operations) {
        client[method] = (input?: object) => send(operation.charAt(0).toLowerCase() + operation.slice(1), input)
    }

    return client as T
}
