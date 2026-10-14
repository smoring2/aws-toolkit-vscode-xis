/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    APIGatewayClient as Client,
    GetResourcesCommand,
    GetResourcesRequest,
    GetRestApisCommand,
    GetRestApisRequest,
    GetStagesCommand,
    Resource,
    RestApi,
    Stages,
    TestInvokeMethodCommand,
    TestInvokeMethodRequest,
    TestInvokeMethodResponse,
} from '@aws-sdk/client-api-gateway'
import globals from '../extensionGlobals'
import { ClassToInterfaceType } from '../utilities/tsUtils'

export type ApiGatewayClient = ClassToInterfaceType<DefaultApiGatewayClient>
export class DefaultApiGatewayClient {
    public constructor(public readonly regionCode: string) {}

    public async *getResourcesForApi(apiId: string): AsyncIterableIterator<Resource> {
        const client = await this.createSdkClient()

        const request: GetResourcesRequest = {
            restApiId: apiId,
        }

        do {
            const response = await client.send(new GetResourcesCommand(request))

            if (response.items !== undefined && response.items.length > 0) {
                yield* response.items
            }

            request.position = response.position
        } while (request.position !== undefined)
    }

    public async getStages(apiId: string): Promise<Stages> {
        const client = await this.createSdkClient()

        const request: GetResourcesRequest = {
            restApiId: apiId,
        }

        return client.send(new GetStagesCommand(request))
    }

    public async *listApis(): AsyncIterableIterator<RestApi> {
        const client = await this.createSdkClient()

        const request: GetRestApisRequest = {}

        do {
            const response = await client.send(new GetRestApisCommand(request))

            if (response.items !== undefined && response.items.length > 0) {
                yield* response.items
            }

            request.position = response.position
        } while (request.position !== undefined)
    }

    public async testInvokeMethod(
        apiId: string,
        resourceId: string,
        method: string,
        body: string,
        pathWithQueryString: string | undefined
    ): Promise<TestInvokeMethodResponse> {
        const client = await this.createSdkClient()
        const request: TestInvokeMethodRequest = {
            restApiId: apiId,
            resourceId: resourceId,
            httpMethod: method,
            body: body,
        }
        if (pathWithQueryString) {
            request.pathWithQueryString = pathWithQueryString
        }

        return await client.send(new TestInvokeMethodCommand(request))
    }

    private async createSdkClient(): Promise<Client> {
        return await globals.sdkClientBuilderV3.createAwsService(Client, undefined, this.regionCode)
    }
}
