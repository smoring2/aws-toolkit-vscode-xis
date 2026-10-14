/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    CloudWatchLogsClient as Client,
    DescribeLogGroupsCommand,
    DescribeLogGroupsRequest,
    DescribeLogGroupsResponse,
    DescribeLogStreamsCommand,
    DescribeLogStreamsRequest,
    DescribeLogStreamsResponse,
    FilterLogEventsCommand,
    FilterLogEventsRequest,
    FilterLogEventsResponse,
    GetLogEventsCommand,
    GetLogEventsRequest,
    GetLogEventsResponse,
    LogGroup,
} from '@aws-sdk/client-cloudwatch-logs'
import globals from '../extensionGlobals'
import { ClassToInterfaceType } from '../utilities/tsUtils'

export type CloudWatchLogsClient = ClassToInterfaceType<DefaultCloudWatchLogsClient>
export class DefaultCloudWatchLogsClient {
    public constructor(public readonly regionCode: string) {}

    public async *describeLogGroups(
        request: DescribeLogGroupsRequest = {}
    ): AsyncIterableIterator<LogGroup> {
        const sdkClient = await this.createSdkClient()
        do {
            const response = await this.invokeDescribeLogGroups(request, sdkClient)
            if (response.logGroups) {
                yield* response.logGroups
            }
            request.nextToken = response.nextToken
        } while (request.nextToken)
    }

    public async describeLogStreams(
        request: DescribeLogStreamsRequest
    ): Promise<DescribeLogStreamsResponse> {
        const sdkClient = await this.createSdkClient()

        return sdkClient.send(new DescribeLogStreamsCommand(request))
    }

    public async getLogEvents(
        request: GetLogEventsRequest
    ): Promise<GetLogEventsResponse> {
        const sdkClient = await this.createSdkClient()

        return sdkClient.send(new GetLogEventsCommand(request))
    }

    public async filterLogEvents(
        request: FilterLogEventsRequest
    ): Promise<FilterLogEventsResponse> {
        const sdkClient = await this.createSdkClient()

        return sdkClient.send(new FilterLogEventsCommand(request))
    }

    protected async invokeDescribeLogGroups(
        request: DescribeLogGroupsRequest,
        sdkClient: Client
    ): Promise<DescribeLogGroupsResponse> {
        return sdkClient.send(new DescribeLogGroupsCommand(request))
    }

    protected async createSdkClient(): Promise<Client> {
        return await globals.sdkClientBuilderV3.createAwsService(Client, undefined, this.regionCode)
    }
}
