/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    BatchDeleteImageCommand,
    CreateRepositoryCommand,
    DeleteRepositoryCommand,
    DescribeImagesCommand,
    DescribeImagesRequest,
    DescribeRepositoriesCommand,
    DescribeRepositoriesRequest,
    ECRClient,
    Repository,
} from '@aws-sdk/client-ecr'
import globals from '../extensionGlobals'
import { AsyncCollection } from '../utilities/asyncCollection'
import { pageableToCollection } from '../utilities/collectionUtils'
import { assertHasProps, ClassToInterfaceType, isNonNullable, RequiredProps } from '../utilities/tsUtils'

export type EcrRepository = RequiredProps<Repository, 'repositoryName' | 'repositoryUri' | 'repositoryArn'>

export type EcrClient = ClassToInterfaceType<DefaultEcrClient>
export class DefaultEcrClient {
    public constructor(public readonly regionCode: string) {}

    public async *describeTags(repositoryName: string): AsyncIterableIterator<string> {
        const sdkClient = await this.createSdkClient()
        const request: DescribeImagesRequest = { repositoryName: repositoryName }
        do {
            const response = await sdkClient.send(new DescribeImagesCommand(request))
            if (response.imageDetails) {
                for (const item of response.imageDetails) {
                    if (item.imageTags !== undefined) {
                        for (const tag of item.imageTags) {
                            yield tag
                        }
                    }
                }
            }
            request.nextToken = response.nextToken
        } while (request.nextToken)
    }

    public async *describeRepositories(): AsyncIterableIterator<EcrRepository> {
        const sdkClient = await this.createSdkClient()
        const request: DescribeRepositoriesRequest = {}
        do {
            const response = await sdkClient.send(new DescribeRepositoriesCommand(request))
            if (response.repositories) {
                yield* response.repositories
                    .map((repo) => {
                        // If any of these are not present, the repo returned is not valid. repositoryUri/Arn
                        // are both based on name, and it's not possible to not have a name
                        if (!repo.repositoryArn || !repo.repositoryName || !repo.repositoryUri) {
                            return undefined
                        } else {
                            return {
                                repositoryName: repo.repositoryName,
                                repositoryUri: repo.repositoryUri,
                                repositoryArn: repo.repositoryArn,
                            }
                        }
                    })
                    .filter((item) => item !== undefined) as EcrRepository[]
            }
            request.nextToken = response.nextToken
        } while (request.nextToken)
    }

    public listAllRepositories(): AsyncCollection<EcrRepository[]> {
        const requester = async (req: DescribeRepositoriesRequest) =>
            (await this.createSdkClient()).send(new DescribeRepositoriesCommand(req))
        const collection = pageableToCollection(requester, {}, 'nextToken', 'repositories')

        return collection.filter(isNonNullable).map((list) => list.map((repo) => (assertHasProps(repo), repo)))
    }

    public async createRepository(repositoryName: string) {
        const sdkClient = await this.createSdkClient()
        return sdkClient.send(new CreateRepositoryCommand({ repositoryName: repositoryName }))
    }

    public async deleteRepository(repositoryName: string): Promise<void> {
        const sdkClient = await this.createSdkClient()
        await sdkClient.send(new DeleteRepositoryCommand({ repositoryName: repositoryName }))
    }

    public async deleteTag(repositoryName: string, tag: string): Promise<void> {
        const sdkClient = await this.createSdkClient()
        await sdkClient.send(
            new BatchDeleteImageCommand({ repositoryName: repositoryName, imageIds: [{ imageTag: tag }] })
        )
    }

    protected async createSdkClient(): Promise<ECRClient> {
        return await globals.sdkClientBuilderV3.createAwsService(ECRClient, undefined, this.regionCode)
    }
}
