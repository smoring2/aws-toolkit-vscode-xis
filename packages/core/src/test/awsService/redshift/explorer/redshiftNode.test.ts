/*!
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
// eslint-disable-next-line header/header
import sinon = require('sinon')
import { RedshiftNode } from '../../../../awsService/redshift/explorer/redshiftNode'
import { DefaultRedshiftClient } from '../../../../shared/clients/redshiftClient'
import { RedshiftClient } from '@aws-sdk/client-redshift'
import { RedshiftServerlessClient } from '@aws-sdk/client-redshift-serverless'
import assert = require('assert')
import { RedshiftWarehouseNode } from '../../../../awsService/redshift/explorer/redshiftWarehouseNode'
import { Cluster, ClustersMessage } from '@aws-sdk/client-redshift'
import { ListWorkgroupsResponse, Workgroup } from '@aws-sdk/client-redshift-serverless'
import { RedshiftWarehouseType } from '../../../../awsService/redshift/models/models'
import { MoreResultsNode } from '../../../../awsexplorer/moreResultsNode'
import { AWSTreeNodeBase } from '../../../../shared/treeview/nodes/awsTreeNodeBase'

function getExpectedProvisionedResponse(withNextToken: boolean): ClustersMessage {
    const response = {
        Clusters: [
            { ClusterNamespaceArn: 'testArn', ClusterIdentifier: 'testId', ClusterAvailabilityStatus: 'available' },
        ] as Cluster[],
    } as ClustersMessage
    if (withNextToken) {
        response.Marker = 'next'
    }
    return response
}

function getExpectedServerlessResponse(withNextToken: boolean): ListWorkgroupsResponse {
    const response = {
        workgroups: [
            { workgroupArn: 'testArn', workgroupName: 'testWorkgroup', status: 'available' },
        ] as unknown as Workgroup[],
    } as ListWorkgroupsResponse
    if (withNextToken) {
        response.nextToken = 'next'
    }
    return response
}

function verifyChildNodeCounts(
    childNodes: AWSTreeNodeBase[],
    expectedProvisionedNodeCount: number,
    expectedServerlessNodeCount: number,
    expectedLoadMoreNodeCount: number
) {
    const provisionedNodes = childNodes.filter(
        (childNode) => (childNode as RedshiftWarehouseNode).warehouseType === RedshiftWarehouseType.PROVISIONED
    )
    const serverlessNodes = childNodes.filter(
        (childNode) => (childNode as RedshiftWarehouseNode).warehouseType === RedshiftWarehouseType.SERVERLESS
    )
    const loadMoreNodes = childNodes.filter((childNode) => childNode instanceof MoreResultsNode)
    assert.strictEqual(
        childNodes.length,
        expectedProvisionedNodeCount + expectedServerlessNodeCount + expectedLoadMoreNodeCount,
        'Total node count mismatch'
    )
    assert.strictEqual(provisionedNodes.length, expectedProvisionedNodeCount, 'ProvisionedNode count mismatch')
    assert.strictEqual(serverlessNodes.length, expectedServerlessNodeCount, 'ServerlessNode count mismatch')
    assert.strictEqual(loadMoreNodes.length, expectedLoadMoreNodeCount, 'LoadMoreNode count mismatch')
}

describe('redshiftNode', function () {
    describe('getChildren', function () {
        let node: RedshiftNode
        let redshiftClient: DefaultRedshiftClient
        let mockRedshift: RedshiftClient
        let mockRedshiftServerless: RedshiftServerlessClient
        const sandbox: sinon.SinonSandbox = sinon.createSandbox()
        const describeClustersStub = sandbox.stub()
        const listWorkgroupsStub = sandbox.stub()

        function verifyStubCallCounts(describeClustersStubCallCount: number, listWorkgroupsStubCallCount: number) {
            assert.strictEqual(
                describeClustersStub.callCount,
                describeClustersStubCallCount,
                'DescribeClustersStub call count mismatch'
            )
            assert.strictEqual(
                listWorkgroupsStub.callCount,
                listWorkgroupsStubCallCount,
                'ListWorkgroupsStub call count mismatch'
            )
        }

        beforeEach(function () {
            mockRedshift = <RedshiftClient>{}
            mockRedshiftServerless = <RedshiftServerlessClient>{}
            redshiftClient = new DefaultRedshiftClient(
                'us-east-1',
                undefined,
                async (r) => Promise.resolve(mockRedshift),
                async (r) => Promise.resolve(mockRedshiftServerless)
            )
            mockRedshift.send = describeClustersStub
            mockRedshiftServerless.send = listWorkgroupsStub
            node = new RedshiftNode(redshiftClient)
        })

        afterEach(function () {
            sandbox.reset()
        })

        it('gets both provisioned and serverless warehouses when no results have been loaded', async () => {
            describeClustersStub.resolves(getExpectedProvisionedResponse(false))
            listWorkgroupsStub.resolves(getExpectedServerlessResponse(false))
            const childNodes = await node.getChildren()
            verifyChildNodeCounts(childNodes, 1, 1, 0)
            verifyStubCallCounts(1, 1)
        })

        it('gets both provisioned and serverless warehouses if results have been loaded but there are more results', async () => {
            describeClustersStub.resolves(getExpectedProvisionedResponse(true))
            listWorkgroupsStub.resolves(getExpectedServerlessResponse(true))
            const childNodes = await node.getChildren()
            verifyChildNodeCounts(childNodes, 1, 1, 1)
            verifyStubCallCounts(1, 1)
        })

        it('gets only provisioned warehouses if results have been loaded and there are only more provisioned warehouses', async () => {
            describeClustersStub.resolves(getExpectedProvisionedResponse(true))
            listWorkgroupsStub.resolves(getExpectedServerlessResponse(false))
            const childNodes = await node.getChildren()
            verifyChildNodeCounts(childNodes, 1, 1, 1)
            await node.loadMoreChildren()
            const newChildNodes = await node.getChildren()
            verifyChildNodeCounts(newChildNodes, 2, 1, 1)
            verifyStubCallCounts(2, 1)
        })

        it('gets only serverless warehouses if results have been loaded and there are only more serverless warehouses', async () => {
            describeClustersStub.resolves(getExpectedProvisionedResponse(false))
            listWorkgroupsStub.resolves(getExpectedServerlessResponse(true))
            const childNodes = await node.getChildren()
            verifyChildNodeCounts(childNodes, 1, 1, 1)
            await node.loadMoreChildren()
            const newChildNodes = await node.getChildren()
            verifyChildNodeCounts(newChildNodes, 1, 2, 1)
            verifyStubCallCounts(1, 2)
        })
    })
})
