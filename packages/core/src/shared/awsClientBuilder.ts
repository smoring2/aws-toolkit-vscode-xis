/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { AwsContext } from './awsContext'
import { DevSettings } from './settings'
import { getUserAgent } from './telemetry/util'
import { telemetry } from './telemetry/telemetry'
import {
    AwsCredentialIdentity,
    AwsCredentialIdentityProvider,
    DeserializeHandler,
    DeserializeMiddleware,
    MetadataBearer,
    TokenIdentity,
    TokenIdentityProvider,
    Provider,
    RetryStrategy,
    RetryStrategyV2,
    UserAgent,
} from '@aws-sdk/types'
import { isThrottlingError, isTransientError } from '@smithy/service-error-classification'

export type AwsClientOptions = {
    credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider
    /** Bearer token (provider) for services which use token-based authentication. */
    token: TokenIdentity | TokenIdentityProvider
    region: string | Provider<string>
    userAgentAppId: string | undefined
    customUserAgent: UserAgent
    requestHandler: any
    apiVersion: string
    endpoint: string
    retryStrategy: RetryStrategy | RetryStrategyV2
}

export type AwsClientConstructor<C> = new (o: any) => C

export interface AwsClient {
    middlewareStack: {
        add: (...args: any[]) => void
    }
}

/**
 * Options accepted by {@link AWSClientBuilderV3.createAwsService}.
 *
 * The `customMiddleware` hook is the AWS SDK v3 analogue of the v2
 * {@link ServiceOptions.onRequestSetup} listeners.
 */
export type ServiceOptionsV3 = Partial<AwsClientOptions> & {
    customMiddleware?: Middleware[]
}

export interface Middleware {
    readonly apply: (stack: AwsClient['middlewareStack']) => void
}

export function recordErrorTelemetry(err: Error & { $metadata?: { requestId?: string } }, serviceName?: string) {
    // TODO: update codegen so `record` enumerates all fields as a flat object instead of
    // intersecting all of the definitions
    interface RequestData {
        requestId?: string
        requestServiceType?: string
    }

    telemetry.record({
        requestId: err.$metadata?.requestId ?? (err as { requestId?: string }).requestId,
        requestServiceType: serviceName,
    } satisfies RequestData as any)
}

function emitOnRequestFailure(serviceName?: string): DeserializeMiddleware<object, MetadataBearer> {
    return (next: DeserializeHandler<object, MetadataBearer>) => async (args: any) => {
        try {
            return await next(args)
        } catch (e: any) {
            // Only record non-retryable failures, matching the v2 builder behaviour.
            if (!isThrottlingError(e) && !isTransientError(e)) {
                recordErrorTelemetry(e, serviceName)
            }
            throw e
        }
    }
}

/**
 * Creates AWS SDK v3 service clients and sets the Toolkit defaults:
 * toolkit credentials, region, user agent, dev endpoint overrides and request
 * failure telemetry.
 */
export class AWSClientBuilderV3 {
    public constructor(private readonly awsContext: AwsContext) {}

    private getCredentialsProvider(): AwsCredentialIdentityProvider {
        const shim = this.awsContext.credentialsShim

        if (!shim) {
            throw new Error('Toolkit is not logged-in.')
        }

        return async () => {
            // Always try to fetch the latest creds first, attempting a refresh if needed.
            const creds = await shim.get()
            if (creds.expiration && creds.expiration.getTime() - Date.now() < 0) {
                return await shim.refresh()
            }
            return creds
        }
    }

    /**
     * Creates an AWS SDK v3 service client of the given type, and sets options defaults.
     *
     * @param type AWS SDK v3 client type, e.g. `S3Client`
     * @param options client configuration options
     * @param region AWS region override
     * @param userAgent Set the Toolkit user agent
     */
    public async createAwsService<C extends AwsClient>(
        type: AwsClientConstructor<C>,
        options?: ServiceOptionsV3,
        region?: string,
        userAgent: boolean = true,
        settings = DevSettings.instance
    ): Promise<C> {
        const opt = { ...options } as ServiceOptionsV3
        const middleware = opt.customMiddleware ?? []
        delete opt.customMiddleware

        if (!opt.credentials) {
            opt.credentials = this.getCredentialsProvider()
        }

        if (!opt.region && region) {
            opt.region = region
        }

        if (userAgent && !opt.customUserAgent) {
            opt.customUserAgent = [[getUserAgent({ includePlatform: true, includeClientId: true })]]
        }

        const serviceName = getServiceId(type)
        if (serviceName) {
            opt.endpoint = settings.get('endpoints', {})[serviceName] ?? opt.endpoint
        }

        const service = new type(opt)

        // Record request IDs to the current context, potentially overriding the field if
        // multiple API calls are made in the same context. We only do failures as successes
        // are generally uninteresting and noisy.
        service.middlewareStack.add(emitOnRequestFailure(serviceName), {
            step: 'deserialize',
            name: 'recordFailureTelemetry',
        })

        for (const m of middleware) {
            m.apply(service.middlewareStack)
        }

        return service
    }
}

/**
 * Derives the service name used by the `aws.dev.endpoints` setting (and request telemetry)
 * from an AWS SDK v3 client class, e.g. `S3Client` -> `s3`.
 */
function getServiceId<C>(type: AwsClientConstructor<C>): string | undefined {
    return type.name ? type.name.replace(/Client$/, '').toLowerCase() : undefined
}
