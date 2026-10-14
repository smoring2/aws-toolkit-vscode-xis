/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import globals from '../../shared/extensionGlobals'
import * as CodeWhispererClient from './codewhispererclient'
import * as CodeWhispererUserClient from './codewhispereruserclient'
import { ListAvailableCustomizationsResponse, SendTelemetryEventRequest } from './codewhispereruserclient'
import { ResponseMetadataBearer, ServiceError, createAwsJsonClient } from '../../shared/awsJsonClient'
import { hasVendedIamCredentials } from '../../auth/auth'
import { CodeWhispererSettings } from '../util/codewhispererSettings'
import { AuthUtil } from '../util/authUtil'
import { isSsoConnection } from '../../auth/connection'
import { pageableToCollection } from '../../shared/utilities/collectionUtils'
import apiConfig = require('./service-2.json')
import userApiConfig = require('./user-service-2.json')
import { session } from '../util/codeWhispererSession'
import { getLogger } from '../../shared/logger'
import { indent } from '../../shared/utilities/textUtilities'
import { keepAliveHeader } from './agent'
import { getClientId, getOptOutPreference, getOperatingSystem } from '../../shared/telemetry/util'
import { extensionVersion, getServiceEnvVarConfig } from '../../shared/vscode/env'
import { DevSettings } from '../../shared/settings'

export interface CodeWhispererConfig {
    readonly region: string
    readonly endpoint: string
}

export const defaultServiceConfig: CodeWhispererConfig = {
    region: 'us-east-1',
    endpoint: 'https://codewhisperer.us-east-1.amazonaws.com/',
}

export function getCodewhispererConfig(): CodeWhispererConfig {
    return {
        ...DevSettings.instance.getServiceConfig('codewhispererService', defaultServiceConfig),

        // Environment variable overrides
        ...getServiceEnvVarConfig('codewhisperer', Object.keys(defaultServiceConfig)),
    }
}

export type ProgrammingLanguage = Readonly<
    CodeWhispererClient.ProgrammingLanguage | CodeWhispererUserClient.ProgrammingLanguage
>
export type FileContext = Readonly<CodeWhispererClient.FileContext | CodeWhispererUserClient.FileContext>
export type ListRecommendationsRequest = Readonly<
    CodeWhispererClient.ListRecommendationsRequest | CodeWhispererUserClient.GenerateCompletionsRequest
>
export type GenerateRecommendationsRequest = Readonly<CodeWhispererClient.GenerateRecommendationsRequest>
export type RecommendationsList = CodeWhispererClient.RecommendationsList | CodeWhispererUserClient.Completions
export type ListRecommendationsResponse =
    | CodeWhispererClient.ListRecommendationsResponse
    | CodeWhispererUserClient.GenerateCompletionsResponse
export type GenerateRecommendationsResponse = CodeWhispererClient.GenerateRecommendationsResponse
export type Recommendation = CodeWhispererClient.Recommendation | CodeWhispererUserClient.Completion
export type Completion = CodeWhispererUserClient.Completion
export type Reference = CodeWhispererClient.Reference | CodeWhispererUserClient.Reference
export type References = CodeWhispererClient.References | CodeWhispererUserClient.References
export type CreateUploadUrlRequest = Readonly<
    CodeWhispererClient.CreateUploadUrlRequest | CodeWhispererUserClient.CreateUploadUrlRequest
>
export type CreateCodeScanRequest = Readonly<
    CodeWhispererClient.CreateCodeScanRequest | CodeWhispererUserClient.StartCodeAnalysisRequest
>
export type GetCodeScanRequest = Readonly<
    CodeWhispererClient.GetCodeScanRequest | CodeWhispererUserClient.GetCodeAnalysisRequest
>
export type ListCodeScanFindingsRequest = Readonly<
    CodeWhispererClient.ListCodeScanFindingsRequest | CodeWhispererUserClient.ListCodeAnalysisFindingsRequest
>
export type SupplementalContext = Readonly<
    CodeWhispererClient.SupplementalContext | CodeWhispererUserClient.SupplementalContext
>
// eslint-disable-next-line @typescript-eslint/no-duplicate-type-constituents
export type ArtifactType = Readonly<CodeWhispererClient.ArtifactType | CodeWhispererUserClient.ArtifactType>
export type ArtifactMap = Readonly<CodeWhispererClient.ArtifactMap | CodeWhispererUserClient.ArtifactMap>
export type ListCodeScanFindingsResponse =
    | CodeWhispererClient.ListCodeScanFindingsResponse
    | CodeWhispererUserClient.ListCodeAnalysisFindingsResponse
export type CreateUploadUrlResponse =
    | CodeWhispererClient.CreateUploadUrlResponse
    | CodeWhispererUserClient.CreateUploadUrlResponse
export type CreateCodeScanResponse =
    | CodeWhispererClient.CreateCodeScanResponse
    | CodeWhispererUserClient.StartCodeAnalysisResponse
export type Import = CodeWhispererUserClient.Import
export type Imports = CodeWhispererUserClient.Imports

export class DefaultCodeWhispererClient {
    private async createSdkClient(): Promise<CodeWhispererClient> {
        const isOptedOut = CodeWhispererSettings.instance.isOptoutEnabled()
        const cwsprConfig = getCodewhispererConfig()

        return createAwsJsonClient<CodeWhispererClient>(apiConfig, {
            region: cwsprConfig.region,
            endpoint: cwsprConfig.endpoint,
            credentials: await AuthUtil.instance.getCredentials(),
            operationHeaders: {
                listRecommendations: { 'x-amzn-codewhisperer-optout': `${isOptedOut}` },
            },
            shouldRetry: (error: ServiceError) => {
                // This logic is for backward compatability with legacy SDK v2 behavior for refreshing
                // credentials. Once the Toolkit adds a file watcher for credentials it won't be needed.
                if (
                    hasVendedIamCredentials() &&
                    error.code === 'AccessDeniedException' &&
                    error.message.match(/expired/i)
                ) {
                    AuthUtil.instance.reauthenticate().catch((e) => {
                        getLogger().error('reauthenticate failed: %s', (e as Error).message)
                    })
                    return true
                }

                return false
            },
        })
    }

    async createUserSdkClient(maxRetries?: number): Promise<CodeWhispererUserClient> {
        const isOptedOut = CodeWhispererSettings.instance.isOptoutEnabled()
        session.setFetchCredentialStart()
        const bearerToken = await AuthUtil.instance.getBearerToken()
        session.setSdkApiCallStart()
        const cwsprConfig = getCodewhispererConfig()

        return createAwsJsonClient<CodeWhispererUserClient>(userApiConfig, {
            region: cwsprConfig.region,
            endpoint: cwsprConfig.endpoint,
            maxRetries: maxRetries,
            bearerToken: bearerToken,
            operationHeaders: {
                generateCompletions: {
                    'x-amzn-codewhisperer-optout': `${isOptedOut}`,
                    // eslint-disable-next-line @typescript-eslint/naming-convention
                    Connection: keepAliveHeader,
                },
            },
        })
    }

    private isBearerTokenAuth(): boolean {
        return isSsoConnection(AuthUtil.instance.conn)
    }

    public async generateRecommendations(
        request: GenerateRecommendationsRequest
    ): Promise<GenerateRecommendationsResponse> {
        return (await this.createSdkClient()).generateRecommendations(request)
    }

    public async listRecommendations(request: ListRecommendationsRequest): Promise<ListRecommendationsResponse> {
        if (this.isBearerTokenAuth()) {
            return await (await this.createUserSdkClient()).generateCompletions(request)
        }
        return (await this.createSdkClient()).listRecommendations(request)
    }

    public async createUploadUrl(
        request: CreateUploadUrlRequest
    ): Promise<CreateUploadUrlResponse & ResponseMetadataBearer> {
        if (this.isBearerTokenAuth()) {
            return (await this.createUserSdkClient()).createUploadUrl(request)
        }
        return (await this.createSdkClient()).createCodeScanUploadUrl(request)
    }

    public async createCodeScan(
        request: CreateCodeScanRequest
    ): Promise<CreateCodeScanResponse & ResponseMetadataBearer> {
        if (this.isBearerTokenAuth()) {
            return (await this.createUserSdkClient()).startCodeAnalysis(request)
        }
        return (await this.createSdkClient()).createCodeScan(request)
    }

    public async getCodeScan(
        request: GetCodeScanRequest
    ): Promise<CodeWhispererClient.GetCodeScanResponse & ResponseMetadataBearer> {
        if (this.isBearerTokenAuth()) {
            return (await this.createUserSdkClient()).getCodeAnalysis(request)
        }
        return (await this.createSdkClient()).getCodeScan(request)
    }

    public async listCodeScanFindings(
        request: ListCodeScanFindingsRequest
    ): Promise<ListCodeScanFindingsResponse & ResponseMetadataBearer> {
        if (this.isBearerTokenAuth()) {
            const req = {
                jobId: request.jobId,
                nextToken: request.nextToken,
                codeAnalysisFindingsSchema: 'codeanalysis/findings/1.0',
            } as CodeWhispererUserClient.ListCodeAnalysisFindingsRequest
            return (await this.createUserSdkClient()).listCodeAnalysisFindings(req)
        }
        return (await this.createSdkClient()).listCodeScanFindings(
            request as CodeWhispererClient.ListCodeScanFindingsRequest
        )
    }

    public async listAvailableCustomizations(): Promise<ListAvailableCustomizationsResponse[]> {
        const client = await this.createUserSdkClient()
        const requester = async (request: CodeWhispererUserClient.ListAvailableCustomizationsRequest) =>
            client.listAvailableCustomizations(request)
        return pageableToCollection(requester, {}, 'nextToken')
            .promise()
            .then((resps) => {
                let logStr = 'amazonq: listAvailableCustomizations API request:'
                for (const resp of resps) {
                    const requestId = resp.$metadata.requestId
                    logStr += `\n${indent('RequestID: ', 4)}${requestId},\n${indent('Customizations:', 4)}`
                    for (const [index, c] of resp.customizations.entries()) {
                        const entry = `${index.toString().padStart(2, '0')}: ${c.name?.trim()}`
                        logStr += `\n${indent(entry, 8)}`
                    }
                }
                getLogger().debug(logStr)
                return resps
            })
    }

    public async sendTelemetryEvent(request: SendTelemetryEventRequest) {
        const requestWithCommonFields: SendTelemetryEventRequest = {
            ...request,
            optOutPreference: getOptOutPreference(),
            userContext: {
                ideCategory: 'VSCODE',
                operatingSystem: getOperatingSystem(),
                product: 'CodeWhisperer', // TODO: update this?
                clientId: getClientId(globals.globalState),
                ideVersion: extensionVersion,
            },
        }
        if (!AuthUtil.instance.isValidEnterpriseSsoInUse() && !globals.telemetry.telemetryEnabled) {
            return
        }
        const response = await (await this.createUserSdkClient()).sendTelemetryEvent(requestWithCommonFields)
        getLogger().debug(`codewhisperer: sendTelemetryEvent requestID: ${response.$metadata.requestId}`)
    }

    /**
     * @description Use this function to start the transformation job.
     * @param request
     * @returns transformationJobId - String id for the Job
     */
    public async codeModernizerStartCodeTransformation(
        request: CodeWhispererUserClient.StartTransformationRequest
    ): Promise<CodeWhispererUserClient.StartTransformationResponse & ResponseMetadataBearer> {
        return (await this.createUserSdkClient()).startTransformation(request)
    }

    /**
     * @description Use this function to stop the transformation job.
     * @param request
     * @returns transformationJobId - String id for the Job
     */
    public async codeModernizerStopCodeTransformation(
        request: CodeWhispererUserClient.StopTransformationRequest
    ): Promise<CodeWhispererUserClient.StopTransformationResponse & ResponseMetadataBearer> {
        return (await this.createUserSdkClient()).stopTransformation(request)
    }

    /**
     * @description Use this function to get the status of the code transformation. We should
     * be polling this function periodically to get updated results. When this function
     * returns COMPLETED we know the transformation is done.
     */
    public async codeModernizerGetCodeTransformation(
        request: CodeWhispererUserClient.GetTransformationRequest
    ): Promise<CodeWhispererUserClient.GetTransformationResponse & ResponseMetadataBearer> {
        // instead of the default of 3 retries, use 8 retries for this API which is polled every 5 seconds
        return (await this.createUserSdkClient(8)).getTransformation(request)
    }

    /**
     * @description After the job has been PAUSED we need to get user intervention. Once that user
     * intervention has been handled we can resume the transformation job.
     * @params transformationJobId - String id returned from StartCodeTransformationResponse
     * @params userActionStatus - String to determine what action the user took, if any.
     */
    public async codeModernizerResumeTransformation(
        request: CodeWhispererUserClient.ResumeTransformationRequest
    ): Promise<CodeWhispererUserClient.ResumeTransformationResponse & ResponseMetadataBearer> {
        return (await this.createUserSdkClient()).resumeTransformation(request)
    }

    /**
     * @description After starting a transformation use this function to display the LLM
     * transformation plan to the user.
     * @params transformationJobId - String id returned from StartCodeTransformationResponse
     */
    public async codeModernizerGetCodeTransformationPlan(
        request: CodeWhispererUserClient.GetTransformationPlanRequest
    ): Promise<CodeWhispererUserClient.GetTransformationPlanResponse & ResponseMetadataBearer> {
        // instead of the default of 3 retries, use 8 retries for this API which is polled every 5 seconds
        return (await this.createUserSdkClient(8)).getTransformationPlan(request)
    }

    public async startCodeFixJob(
        request: CodeWhispererUserClient.StartCodeFixJobRequest
    ): Promise<CodeWhispererUserClient.StartCodeFixJobResponse & ResponseMetadataBearer> {
        return (await this.createUserSdkClient()).startCodeFixJob(request)
    }

    public async getCodeFixJob(
        request: CodeWhispererUserClient.GetCodeFixJobRequest
    ): Promise<CodeWhispererUserClient.GetCodeFixJobResponse & ResponseMetadataBearer> {
        return (await this.createUserSdkClient()).getCodeFixJob(request)
    }

    public async startTestGeneration(
        request: CodeWhispererUserClient.StartTestGenerationRequest
    ): Promise<CodeWhispererUserClient.StartTestGenerationResponse & ResponseMetadataBearer> {
        return (await this.createUserSdkClient()).startTestGeneration(request)
    }

    public async getTestGeneration(
        request: CodeWhispererUserClient.GetTestGenerationRequest
    ): Promise<CodeWhispererUserClient.GetTestGenerationResponse & ResponseMetadataBearer> {
        return (await this.createUserSdkClient()).getTestGeneration(request)
    }
}

export const codeWhispererClient = new DefaultCodeWhispererClient()

export class CognitoCredentialsError extends Error {}
