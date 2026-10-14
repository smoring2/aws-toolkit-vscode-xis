/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Toolkit-local logic for telemetry.
 */

import { Sha256 } from '@aws-crypto/sha256-js'
import { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@aws-sdk/types'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'
import * as os from 'os'
import * as vscode from 'vscode'
import { extensionVersion, isAutomation } from '../vscode/env'
import { getLogger } from '../logger'
import * as ClientTelemetry from './clienttelemetry'
import { AWSProduct, MetricDatum } from './clienttelemetry'
import { DevSettings } from '../settings'
import { ClassToInterfaceType } from '../utilities/tsUtils'
import { getComputeEnvType, getSessionId } from './util'

/** `signingName` of the ToolkitTelemetry service, see `service-2.json`. */
const signingName = 'execute-api'

/**
 * Minimal client for the (private) ToolkitTelemetry service.
 *
 * The service has no AWS SDK v3 client package, so its two REST-JSON operations are
 * implemented here with SigV4-signed requests.
 */
class ToolkitTelemetryClient {
    private readonly signer: SignatureV4

    public constructor(
        private readonly endpoint: string,
        region: string,
        credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider
    ) {
        this.signer = new SignatureV4({
            credentials,
            region,
            service: signingName,
            sha256: Sha256,
        })
    }

    public async postMetrics(request: ClientTelemetry.PostMetricsRequest): Promise<void> {
        return this.post('/metrics', request)
    }

    public async postFeedback(request: ClientTelemetry.PostFeedbackRequest): Promise<void> {
        return this.post('/feedback', request)
    }

    private async post(path: string, request: object): Promise<void> {
        const url = new URL(this.endpoint)
        const body = JSON.stringify(request)
        const signed = await this.signer.sign(
            new HttpRequest({
                method: 'POST',
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port === '' ? undefined : Number(url.port),
                path: path,
                headers: {
                    host: url.host,
                    'content-type': 'application/json',
                },
                body: body,
            })
        )

        const response = await fetch(`${url.origin}${path}`, {
            method: 'POST',
            headers: signed.headers as Record<string, string>,
            body: body,
        })

        if (!response.ok) {
            throw new Error(`ToolkitTelemetry: POST ${path} failed (${response.status}): ${await response.text()}`)
        }
    }
}

export const accountMetadataKey = 'awsAccount'
export const regionKey = 'awsRegion'
export const computeRegionKey = 'computeRegion'

export enum AccountStatus {
    NotApplicable = 'n/a',
    NotSet = 'not-set',
    Invalid = 'invalid',
}

export const metadataFieldName = {
    RESULT: 'result',
    DURATION: 'duration',
    REASON: 'reason',
}

export enum MetadataResult {
    Pass = 'Succeeded',
    Fail = 'Failed',
    Cancel = 'Cancelled',
}

interface TelemetryConfiguration {
    readonly endpoint: string
    readonly identityPool: string
}

export interface TelemetryFeedback {
    sentiment: ClientTelemetry.Sentiment
    comment: ClientTelemetry.Comment
}

export type TelemetryClient = ClassToInterfaceType<DefaultTelemetryClient>

export class DefaultTelemetryClient implements TelemetryClient {
    private static readonly defaultIdentityPool = 'us-east-1:820fd6d1-95c0-4ca4-bffb-3f01d32da842'
    private static readonly defaultTelemetryEndpoint = 'https://client-telemetry.us-east-1.amazonaws.com'

    static #productName: AWSProduct

    public static set productName(val: AWSProduct) {
        getLogger().info(`Telemetry product: ${val}`)
        this.#productName = val
    }

    public static get productName() {
        if (!this.#productName) {
            throw new Error('DefaultTelemetryClient.productName is not initialized.')
        }
        return this.#productName
    }

    private static initializeConfig(): TelemetryConfiguration {
        const settings = DevSettings.instance

        return {
            endpoint: settings.get('telemetryEndpoint', this.defaultTelemetryEndpoint),
            identityPool: settings.get('telemetryUserPool', this.defaultIdentityPool),
        }
    }

    public static config = DefaultTelemetryClient.initializeConfig()

    private readonly logger = getLogger()

    private constructor(
        private readonly clientId: string,
        private readonly client: ToolkitTelemetryClient
    ) {}

    /**
     * Returns failed events
     * @param batch batch of events
     */
    public async postMetrics(batch: MetricDatum[]): Promise<MetricDatum[] | undefined> {
        try {
            // If our batching logic rejected all of the telemetry, don't try to post
            if (batch.length === 0) {
                return undefined
            }

            if (!isAutomation()) {
                await this.client.postMetrics({
                    AWSProduct: DefaultTelemetryClient.productName,
                    AWSProductVersion: extensionVersion,
                    ClientID: this.clientId,
                    SessionID: getSessionId(),
                    OS: os.platform(),
                    OSVersion: os.release(),
                    ComputeEnv: await getComputeEnvType(),
                    ParentProduct: vscode.env.appName,
                    ParentProductVersion: vscode.version,
                    MetricData: batch,
                })
                this.logger.info(`telemetry: sent batch (size=${batch.length})`)
            } else {
                this.logger.info(`telemetry: (test mode) dropped batch (size=${batch.length})`)
            }

            return undefined
        } catch (err) {
            this.logger.error(`Batch error: ${err}`)

            return batch
        }
    }

    public async postFeedback(feedback: TelemetryFeedback): Promise<void> {
        try {
            await this.client.postFeedback({
                AWSProduct: DefaultTelemetryClient.productName,
                AWSProductVersion: extensionVersion,
                OS: os.platform(),
                OSVersion: os.release(),
                ComputeEnv: await getComputeEnvType(),
                ParentProduct: vscode.env.appName,
                ParentProductVersion: vscode.version,
                Comment: feedback.comment,
                Sentiment: feedback.sentiment,
            })
            this.logger.debug(`ComputeEnv detected for telemetry: ${await getComputeEnvType()}`)
            this.logger.info('Successfully posted feedback')
        } catch (err) {
            this.logger.error(`Failed to post feedback: ${err}`)
            throw new Error(`Failed to post feedback: ${err}`)
        }
    }

    public static async createDefaultClient(
        clientId: string,
        region: string,
        credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider
    ): Promise<DefaultTelemetryClient> {
        return new DefaultTelemetryClient(
            clientId,
            new ToolkitTelemetryClient(DefaultTelemetryClient.config.endpoint, region, credentials)
        )
    }
}
