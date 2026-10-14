/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    DeleteFunctionCommand,
    FunctionConfiguration,
    FunctionUrlConfig,
    GetFunctionCommand,
    GetFunctionCommandOutput,
    InvocationResponse,
    InvokeCommand,
    LambdaClient as Client,
    ListFunctionUrlConfigsCommand,
    ListFunctionsCommand,
    ListFunctionsRequest,
    UpdateFunctionCodeCommand,
    waitUntilFunctionUpdatedV2,
} from '@aws-sdk/client-lambda'
import { ToolkitError } from '../errors'
import globals from '../extensionGlobals'
import { getLogger } from '../logger'
import { ClassToInterfaceType } from '../utilities/tsUtils'

export type LambdaClient = ClassToInterfaceType<DefaultLambdaClient>

export class DefaultLambdaClient {
    private readonly defaultTimeoutInMs: number

    public constructor(public readonly regionCode: string) {
        this.defaultTimeoutInMs = 5 * 60 * 1000 // 5 minutes (SDK default is 2 minutes)
    }

    public async deleteFunction(name: string): Promise<void> {
        const sdkClient = await this.createSdkClient()

        // `send` rejects with the service error, so no explicit error check is needed.
        await sdkClient.send(
            new DeleteFunctionCommand({
                FunctionName: name,
            })
        )
    }

    public async invoke(name: string, payload?: Uint8Array): Promise<InvocationResponse> {
        const sdkClient = await this.createSdkClient()

        const response = await sdkClient.send(
            new InvokeCommand({
                FunctionName: name,
                LogType: 'Tail',
                Payload: payload,
            })
        )

        return response
    }

    public async *listFunctions(): AsyncIterableIterator<FunctionConfiguration> {
        const client = await this.createSdkClient()

        const request: ListFunctionsRequest = {}
        do {
            const response = await client.send(new ListFunctionsCommand(request))

            if (response.Functions) {
                yield* response.Functions
            }

            request.Marker = response.NextMarker
        } while (request.Marker)
    }

    public async getFunction(name: string): Promise<GetFunctionCommandOutput> {
        getLogger().debug(`GetFunction called for function: ${name}`)
        const client = await this.createSdkClient()

        try {
            const response = await client.send(new GetFunctionCommand({ FunctionName: name }))
            // prune `Code` from logs so we don't reveal a signed link to customer resources.
            getLogger().debug('GetFunction returned response (code section pruned): %O', {
                ...response,
                Code: 'Pruned',
            })
            return response
        } catch (e) {
            getLogger().error('Failed to get function: %s', e)
            throw e
        }
    }

    public async getFunctionUrlConfigs(name: string): Promise<FunctionUrlConfig[]> {
        getLogger().debug(`GetFunctionUrlConfig called for function: ${name}`)
        const client = await this.createSdkClient()

        try {
            const response = await client.send(new ListFunctionUrlConfigsCommand({ FunctionName: name }))
            // prune `Code` from logs so we don't reveal a signed link to customer resources.
            getLogger().debug('GetFunctionUrlConfig returned response (code section pruned): %O', {
                ...response,
                Code: 'Pruned',
            })
            return response.FunctionUrlConfigs ?? []
        } catch (e) {
            throw ToolkitError.chain(e, 'Failed to get Lambda function URLs')
        }
    }

    public async updateFunctionCode(name: string, zipFile: Uint8Array): Promise<FunctionConfiguration> {
        getLogger().debug(`updateFunctionCode called for function: ${name}`)
        const client = await this.createSdkClient()

        try {
            const response = await client.send(
                new UpdateFunctionCodeCommand({
                    FunctionName: name,
                    Publish: true,
                    ZipFile: zipFile,
                })
            )
            getLogger().debug('updateFunctionCode returned response: %O', response)
            await waitUntilFunctionUpdatedV2({ client, maxWaitTime: 5 * 60 }, { FunctionName: name })

            return response
        } catch (e) {
            getLogger().error('Failed to run updateFunctionCode: %s', e)
            throw e
        }
    }

    private async createSdkClient(): Promise<Client> {
        return await globals.sdkClientBuilderV3.createAwsService(
            Client,
            { requestHandler: { requestTimeout: this.defaultTimeoutInMs } },
            this.regionCode
        )
    }
}
