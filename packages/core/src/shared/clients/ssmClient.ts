/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    DescribeInstanceInformationCommand,
    DescribeInstanceInformationRequest,
    DescribeSessionsCommand,
    DescribeSessionsRequest,
    GetCommandInvocationCommandOutput,
    InstanceInformation,
    SSMClient,
    SendCommandCommand,
    SendCommandResult,
    Session,
    SessionState,
    StartSessionCommand,
    StartSessionResponse,
    TerminateSessionCommand,
    TerminateSessionResponse,
    waitUntilCommandExecuted,
} from '@aws-sdk/client-ssm'
import { getLogger } from '../logger/logger'
import globals from '../extensionGlobals'
import { pageableToCollection } from '../utilities/collectionUtils'
import { ToolkitError } from '../errors'

export class SsmClient {
    public constructor(public readonly regionCode: string) {}

    private async createSdkClient(): Promise<SSMClient> {
        return await globals.sdkClientBuilderV3.createAwsService(SSMClient, undefined, this.regionCode)
    }

    public async terminateSession(session: Session): Promise<TerminateSessionResponse> {
        const sessionId = session.SessionId!
        return await this.terminateSessionFromId(sessionId)
    }

    public async terminateSessionFromId(sessionId: string): Promise<TerminateSessionResponse> {
        const client = await this.createSdkClient()
        const termination = await client
            .send(new TerminateSessionCommand({ SessionId: sessionId }))
            .catch((err) => {
                getLogger().warn(`ssm: failed to terminate session "${sessionId}": %s`, err)
            })

        return termination!
    }

    public async startSession(
        target: string,
        document?: string,
        parameters?: Record<string, string[]>
    ): Promise<StartSessionResponse> {
        const client = await this.createSdkClient()
        const response = await client.send(
            new StartSessionCommand({ Target: target, DocumentName: document, Parameters: parameters })
        )
        return response
    }

    public async describeInstance(target: string): Promise<InstanceInformation> {
        const client = await this.createSdkClient()
        const requester = async (req: DescribeInstanceInformationRequest) =>
            client.send(new DescribeInstanceInformationCommand(req))
        const request: DescribeInstanceInformationRequest = {
            InstanceInformationFilterList: [
                {
                    key: 'InstanceIds',
                    valueSet: [target],
                },
            ],
        }

        const response = await pageableToCollection(requester, request, 'NextToken', 'InstanceInformationList')
            .flatten()
            .flatten()
            .promise()
        return response[0]!
    }

    public async getTargetPlatformName(target: string): Promise<string> {
        const instanceInformation = await this.describeInstance(target)
        return instanceInformation.PlatformName!
    }

    public async sendCommand(
        target: string,
        documentName: string,
        parameters: Record<string, string[]>
    ): Promise<SendCommandResult> {
        const client = await this.createSdkClient()
        const response = await client.send(
            new SendCommandCommand({ InstanceIds: [target], DocumentName: documentName, Parameters: parameters })
        )
        return response
    }

    public async sendCommandAndWait(
        target: string,
        documentName: string,
        parameters: Record<string, string[]>
    ): Promise<GetCommandInvocationCommandOutput> {
        const response = await this.sendCommand(target, documentName, parameters)
        const client = await this.createSdkClient()
        try {
            const commandId = response.Command!.CommandId!
            const result = await waitUntilCommandExecuted(
                { client, maxWaitTime: 600 },
                { CommandId: commandId, InstanceId: target }
            )
            return result.reason as GetCommandInvocationCommandOutput
        } catch (err) {
            throw new ToolkitError(`Failed in sending command to target ${target}`, { cause: err as Error })
        }
    }

    public async getInstanceAgentPingStatus(target: string): Promise<string> {
        const instanceInformation = await this.describeInstance(target)
        return instanceInformation ? instanceInformation.PingStatus! : 'Inactive'
    }

    public async describeSessions(state: SessionState) {
        const client = await this.createSdkClient()
        const requester = async (req: DescribeSessionsRequest) => client.send(new DescribeSessionsCommand(req))

        const response = await pageableToCollection(requester, { State: state }, 'NextToken', 'Sessions').promise()

        return response
    }
}
