/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    AppRunnerClient as Client,
    CreateConnectionCommand,
    CreateConnectionRequest,
    CreateConnectionResponse,
    CreateServiceCommand,
    CreateServiceRequest,
    CreateServiceResponse,
    DeleteServiceCommand,
    DeleteServiceRequest,
    DeleteServiceResponse,
    DescribeServiceCommand,
    DescribeServiceRequest,
    DescribeServiceResponse,
    ListConnectionsCommand,
    ListConnectionsRequest,
    ListConnectionsResponse,
    ListOperationsCommand,
    ListOperationsRequest,
    ListOperationsResponse,
    ListServicesCommand,
    ListServicesRequest,
    ListServicesResponse,
    PauseServiceCommand,
    PauseServiceRequest,
    PauseServiceResponse,
    ResumeServiceCommand,
    ResumeServiceRequest,
    ResumeServiceResponse,
    StartDeploymentCommand,
    StartDeploymentRequest,
    StartDeploymentResponse,
    UpdateServiceCommand,
    UpdateServiceRequest,
    UpdateServiceResponse,
} from '@aws-sdk/client-apprunner'
import globals from '../extensionGlobals'

import { ClassToInterfaceType } from '../utilities/tsUtils'

export type AppRunnerClient = ClassToInterfaceType<DefaultAppRunnerClient>

export class DefaultAppRunnerClient {
    public constructor(public readonly regionCode: string) {}

    public async createService(request: CreateServiceRequest): Promise<CreateServiceResponse> {
        return (await this.createSdkClient()).send(new CreateServiceCommand(request))
    }

    public async listServices(request: ListServicesRequest): Promise<ListServicesResponse> {
        return (await this.createSdkClient()).send(new ListServicesCommand(request))
    }

    public async pauseService(request: PauseServiceRequest): Promise<PauseServiceResponse> {
        return (await this.createSdkClient()).send(new PauseServiceCommand(request))
    }

    public async resumeService(request: ResumeServiceRequest): Promise<ResumeServiceResponse> {
        return (await this.createSdkClient()).send(new ResumeServiceCommand(request))
    }

    public async updateService(request: UpdateServiceRequest): Promise<UpdateServiceResponse> {
        return (await this.createSdkClient()).send(new UpdateServiceCommand(request))
    }

    public async createConnection(request: CreateConnectionRequest): Promise<CreateConnectionResponse> {
        return (await this.createSdkClient()).send(new CreateConnectionCommand(request))
    }

    public async listConnections(request: ListConnectionsRequest = {}): Promise<ListConnectionsResponse> {
        return (await this.createSdkClient()).send(new ListConnectionsCommand(request))
    }

    public async describeService(request: DescribeServiceRequest): Promise<DescribeServiceResponse> {
        return (await this.createSdkClient()).send(new DescribeServiceCommand(request))
    }

    public async startDeployment(request: StartDeploymentRequest): Promise<StartDeploymentResponse> {
        return (await this.createSdkClient()).send(new StartDeploymentCommand(request))
    }

    public async listOperations(request: ListOperationsRequest): Promise<ListOperationsResponse> {
        return (await this.createSdkClient()).send(new ListOperationsCommand(request))
    }

    public async deleteService(request: DeleteServiceRequest): Promise<DeleteServiceResponse> {
        return (await this.createSdkClient()).send(new DeleteServiceCommand(request))
    }

    protected async createSdkClient(): Promise<Client> {
        return await globals.sdkClientBuilderV3.createAwsService(Client, undefined, this.regionCode)
    }
}
