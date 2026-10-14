/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    AttachPolicyRequest,
    AttachThingPrincipalRequest,
    CreateKeysAndCertificateRequest,
    CreateKeysAndCertificateResponse,
    CreatePolicyRequest,
    CreatePolicyResponse,
    CreatePolicyVersionRequest,
    CreatePolicyVersionResponse,
    CreateThingResponse,
    DeleteCertificateRequest,
    DeletePolicyRequest,
    DeletePolicyVersionRequest,
    DeleteThingRequest,
    DeleteThingResponse,
    DescribeCertificateRequest,
    DescribeCertificateResponse,
    DescribeEndpointRequest,
    DescribeEndpointResponse,
    DetachPolicyRequest,
    DetachThingPrincipalRequest,
    GetPolicyVersionRequest,
    GetPolicyVersionResponse,
    ListCertificatesRequest,
    ListCertificatesResponse,
    ListPoliciesRequest,
    ListPoliciesResponse,
    ListPolicyVersionsRequest,
    ListPolicyVersionsResponse,
    ListPrincipalPoliciesRequest,
    ListPrincipalThingsRequest,
    ListPrincipalThingsResponse,
    ListTargetsForPolicyRequest,
    ListTargetsForPolicyResponse,
    ListThingPrincipalsRequest,
    ListThingPrincipalsResponse,
    ListThingsRequest,
    ListThingsResponse,
    PolicyVersion,
    SetDefaultPolicyVersionRequest,
    UpdateCertificateRequest,
} from '@aws-sdk/client-iot'
import assert from 'assert'
import { IoTClient } from '@aws-sdk/client-iot'
import { DefaultIotClient, ListThingCertificatesResponse } from '../../../shared/clients/iotClient'
import sinon from 'sinon'

class FakeAwsError extends Error {
    public region: string = 'us-west-2'

    public constructor(message: string) {
        super(message)
    }
}

describe('DefaultIotClient', function () {
    const region = 'us-west-2'
    const thingName = 'thing'
    const policyName = 'policy'
    const policyDocument = '{ "key": "value" }'
    const nextToken = 'nextToken'
    const marker = nextToken
    const maxResults = 10
    const pageSize = maxResults
    /** Stubs for each AWS SDK v3 command, keyed by the command class name. */
    let commandStubs: Record<string, sinon.SinonStub>
    let mockIot: IoTClient

    function commandStub(name: string): sinon.SinonStub {
        commandStubs[name] = commandStubs[name] ?? sinon.stub()
        return commandStubs[name]
    }

    beforeEach(function () {
        commandStubs = {}
        mockIot = {
            send: (command: any) => commandStub(command.constructor.name)(command.input),
        } as unknown as IoTClient
    })

    const error = new FakeAwsError('Expected failure')

    function createClient({ regionCode = region }: { regionCode?: string } = {}): DefaultIotClient {
        return new DefaultIotClient(regionCode, () => Promise.resolve(mockIot))
    }

    /* Functions that create or retrieve resources. */

    describe('createThing', function () {
        const expectedResponse: CreateThingResponse = { thingName: thingName, thingArn: 'arn' }
        it('creates a thing', async function () {
            commandStub('CreateThingCommand').resolves(expectedResponse)

            const response = await createClient().createThing({ thingName })

            assert(commandStub('CreateThingCommand').calledOnceWithExactly)
            assert.deepStrictEqual(response, expectedResponse)
        })

        it('throws an Error on failure', async function () {
            commandStub('CreateThingCommand').rejects(error)

            await assert.rejects(createClient().createThing({ thingName }), error)
        })
    })

    describe('createCertificateAndKeys', function () {
        const certificateId = 'cert1'
        const input: CreateKeysAndCertificateRequest = { setAsActive: undefined }
        const expectedResponse: CreateKeysAndCertificateResponse = {
            certificateId,
            certificateArn: 'arn',
            certificatePem: 'pem',
            keyPair: { PublicKey: 'publicKey', PrivateKey: 'privateKey' },
        }

        it('creates Certificate and Key Pair', async function () {
            commandStub('CreateKeysAndCertificateCommand').resolves(expectedResponse)

            const response = await createClient().createCertificateAndKeys(input)

            assert.deepStrictEqual(response, expectedResponse)
        })

        it('throws an Error on failure', async function () {
            commandStub('CreateKeysAndCertificateCommand').rejects(error)

            await assert.rejects(createClient().createCertificateAndKeys(input), error)
        })
    })

    describe('getEndpoint', function () {
        const input: DescribeEndpointRequest = { endpointType: 'iot:Data-ATS' }
        const endpointAddress = 'address'
        const describeResponse: DescribeEndpointResponse = { endpointAddress }

        it('gets endpoint', async function () {
            commandStub('DescribeEndpointCommand').resolves(describeResponse)

            const response = await createClient().getEndpoint()

            commandStub('DescribeEndpointCommand').calledOnceWithExactly(sinon.match(input))
            assert.deepStrictEqual(response, endpointAddress)
        })

        it('throws an Error on failure', async function () {
            commandStub('DescribeEndpointCommand').rejects(error)

            await assert.rejects(createClient().getEndpoint(), error)
        })
    })

    describe('getPolicyVersion', function () {
        const input: GetPolicyVersionRequest = { policyName, policyVersionId: '1' }
        const expectedResponse: GetPolicyVersionResponse = {
            policyName,
            policyDocument,
            policyArn: 'arn1',
            policyVersionId: '1',
        }

        it('gets policy document for version', async function () {
            commandStub('GetPolicyVersionCommand').resolves(expectedResponse)

            const response = await createClient().getPolicyVersion(input)

            assert.deepStrictEqual(response, expectedResponse)
        })

        it('throws an Error on failure', async function () {
            commandStub('GetPolicyVersionCommand').rejects(error)

            await assert.rejects(createClient().getPolicyVersion(input), error)
        })
    })

    /* Functions that return void .*/

    describe('deleteThing', function () {
        const input: DeleteThingRequest = { thingName }

        it('deletes a thing', async function () {
            commandStub('DeleteThingCommand').resolves({} as DeleteThingResponse)

            await createClient().deleteThing({ thingName })

            assert(commandStub('DeleteThingCommand').calledOnceWithExactly(sinon.match(input)))
        })

        it('throws an Error on failure', async function () {
            commandStub('DeleteThingCommand').rejects(error)

            await assert.rejects(createClient().deleteThing({ thingName }), error)
        })
    })

    describe('deleteCertificate', function () {
        const certificateId = 'cert1'
        const input: DeleteCertificateRequest = { certificateId, forceDelete: undefined }

        it('deletes a certificate', async function () {
            commandStub('DeleteCertificateCommand').resolves()

            await createClient().deleteCertificate(input)

            assert(commandStub('DeleteCertificateCommand').calledOnceWithExactly(sinon.match(input)))
        })

        it('throws an Error on failure', async function () {
            commandStub('DeleteCertificateCommand').rejects(error)

            await assert.rejects(createClient().deleteCertificate(input), error)
        })
    })

    describe('updateCertificate', function () {
        const certificateId = 'cert1'
        const input: UpdateCertificateRequest = { certificateId, newStatus: 'ACTIVE' }

        it('updates a certificate', async function () {
            commandStub('UpdateCertificateCommand').resolves()

            await createClient().updateCertificate(input)

            assert(commandStub('UpdateCertificateCommand').calledOnceWithExactly(sinon.match(input)))
        })

        it('throws an Error on failure', async function () {
            commandStub('UpdateCertificateCommand').rejects(error)

            await assert.rejects(createClient().updateCertificate(input), error)
        })
    })

    describe('attachThingPrincipal', function () {
        const input: AttachThingPrincipalRequest = { thingName, principal: 'arn1' }

        it('attaches a certificate to a Thing', async function () {
            commandStub('AttachThingPrincipalCommand').resolves()

            await createClient().attachThingPrincipal(input)

            assert(commandStub('AttachThingPrincipalCommand').calledOnceWithExactly(sinon.match(input)))
        })

        it('throws an Error on failure', async function () {
            commandStub('AttachThingPrincipalCommand').rejects(error)

            await assert.rejects(createClient().attachThingPrincipal(input), error)
        })
    })

    describe('detachThingPrincipal', function () {
        const input: DetachThingPrincipalRequest = { thingName, principal: 'arn1' }

        it('detaches a certificate from a Thing', async function () {
            commandStub('DetachThingPrincipalCommand').resolves()

            await createClient().detachThingPrincipal(input)

            assert(commandStub('DetachThingPrincipalCommand').calledOnceWithExactly(sinon.match(input)))
        })

        it('throws an Error on failure', async function () {
            commandStub('DetachThingPrincipalCommand').rejects(error)

            await assert.rejects(createClient().detachThingPrincipal(input), error)
        })
    })

    describe('attachPolicy', function () {
        const input: AttachPolicyRequest = { policyName, target: 'arn1' }

        it('attaches a policy to a certificate', async function () {
            commandStub('AttachPolicyCommand').resolves()

            await createClient().attachPolicy(input)

            assert(commandStub('AttachPolicyCommand').calledOnceWithExactly(sinon.match(input)))
        })

        it('throws an Error on failure', async function () {
            commandStub('AttachPolicyCommand').rejects(error)

            await assert.rejects(createClient().attachPolicy(input), error)
        })
    })

    describe('detachPolicy', function () {
        const input: DetachPolicyRequest = { policyName, target: 'arn1' }

        it('detaches a policy from a certificate', async function () {
            commandStub('DetachPolicyCommand').resolves()

            await createClient().detachPolicy(input)

            assert(commandStub('DetachPolicyCommand').calledOnceWithExactly(sinon.match(input)))
        })

        it('throws an Error on failure', async function () {
            commandStub('DetachPolicyCommand').rejects(error)

            await assert.rejects(createClient().detachPolicy(input), error)
        })
    })

    describe('createPolicy', function () {
        const input: CreatePolicyRequest = { policyName, policyDocument }
        const expectedResponse: CreatePolicyResponse = { policyName, policyDocument, policyArn: 'arn1' }

        it('creates a policy from a document', async function () {
            commandStub('CreatePolicyCommand').resolves(expectedResponse)

            await createClient().createPolicy(input)

            assert(commandStub('CreatePolicyCommand').calledOnceWithExactly(sinon.match(input)))
        })

        it('throws an Error on failure', async function () {
            commandStub('CreatePolicyCommand').rejects(error)

            await assert.rejects(createClient().createPolicy(input), error)
        })
    })

    describe('deletePolicy', function () {
        const input: DeletePolicyRequest = { policyName }

        it('deletes a policy', async function () {
            commandStub('DeletePolicyCommand').resolves()

            await createClient().deletePolicy(input)

            assert(commandStub('DeletePolicyCommand').calledOnceWithExactly(sinon.match(input)))
        })

        it('throws an Error on failure', async function () {
            commandStub('DeletePolicyCommand').rejects(error)

            await assert.rejects(createClient().deletePolicy(input), error)
        })
    })

    describe('createPolicyVersion', function () {
        const input: CreatePolicyVersionRequest = { policyName, policyDocument }
        const expectedResponse: CreatePolicyVersionResponse = { policyDocument, policyArn: 'arn1' }

        it('creates a policy version from a document', async function () {
            commandStub('CreatePolicyVersionCommand').resolves(expectedResponse)

            await createClient().createPolicyVersion(input)

            assert(commandStub('CreatePolicyVersionCommand').calledOnceWithExactly(sinon.match(input)))
        })

        it('throws an Error on failure', async function () {
            commandStub('CreatePolicyVersionCommand').rejects(error)

            await assert.rejects(createClient().createPolicyVersion(input), error)
        })
    })

    describe('deletePolicyVersion', function () {
        const input: DeletePolicyVersionRequest = { policyName, policyVersionId: '1' }

        it('deletes a policy version', async function () {
            commandStub('DeletePolicyVersionCommand').resolves()

            await createClient().deletePolicyVersion(input)

            assert(commandStub('DeletePolicyVersionCommand').calledOnceWithExactly(sinon.match(input)))
        })

        it('throws an Error on failure', async function () {
            commandStub('DeletePolicyVersionCommand').rejects(error)

            await assert.rejects(createClient().deletePolicyVersion(input), error)
        })
    })

    describe('setDefaultPolicyVersion', function () {
        const input: SetDefaultPolicyVersionRequest = { policyName, policyVersionId: '1' }

        it('deletes a policy version', async function () {
            commandStub('SetDefaultPolicyVersionCommand').resolves()

            await createClient().setDefaultPolicyVersion(input)

            assert(commandStub('SetDefaultPolicyVersionCommand').calledOnceWithExactly(sinon.match(input)))
        })

        it('throws an Error on failure', async function () {
            commandStub('SetDefaultPolicyVersionCommand').rejects(error)

            await assert.rejects(createClient().setDefaultPolicyVersion(input), error)
        })
    })

    // /* Functions that list resources.

    describe('listThings', function () {
        const input: ListThingsRequest = { maxResults, nextToken }
        const expectedResponse: ListThingsResponse = { things: [{ thingName: 'thing1' }], nextToken }

        it('lists things', async function () {
            commandStub('ListThingsCommand').resolves(expectedResponse)

            const response = await createClient().listThings(input)

            assert.deepStrictEqual(response, expectedResponse)
        })

        it('throws an Error on failure', async function () {
            commandStub('ListThingsCommand').rejects(error)

            await assert.rejects(createClient().listThings(input), error)
        })
    })

    describe('listCertificates', function () {
        const input: ListCertificatesRequest = { pageSize, marker, ascendingOrder: undefined }
        const expectedResponse: ListCertificatesResponse = {
            certificates: [{ certificateId: 'cert1' }],
            nextMarker: marker,
        }

        it('lists certificates', async function () {
            commandStub('ListCertificatesCommand').resolves(expectedResponse)

            const response = await createClient().listCertificates(input)

            assert.deepStrictEqual(response, expectedResponse)
        })

        it('throws an Error on failure', async function () {
            commandStub('ListCertificatesCommand').rejects(error)

            await assert.rejects(createClient().listCertificates(input), error)
        })
    })

    describe('listThingCertificates', function () {
        const certificateId = 'cert1'
        const certArn = 'arn:aws:iot:us-west-2:0123456789:cert/cert1'
        const input: ListThingPrincipalsRequest = { thingName, maxResults, nextToken }
        const principalsResponse: ListThingPrincipalsResponse = { principals: [certArn], nextToken }

        const describeInput: DescribeCertificateRequest = { certificateId }
        const describeResponse: DescribeCertificateResponse = {
            certificateDescription: { certificateId, certificateArn: certArn },
        }

        const expectedResponse: ListThingCertificatesResponse = {
            certificates: [{ certificateId, certificateArn: certArn }],
            nextToken: nextToken,
        }

        it('lists certificates', async function () {
            commandStub('ListThingPrincipalsCommand').resolves(principalsResponse)
            commandStub('DescribeCertificateCommand').resolves(describeResponse)

            const response = await createClient().listThingCertificates(input)

            commandStub('DescribeCertificateCommand').calledOnceWithExactly(sinon.match(describeInput))
            assert.deepStrictEqual(response, expectedResponse)
        })

        it('throws an Error when certificate listing fails', async function () {
            commandStub('ListThingPrincipalsCommand').rejects(error)

            await assert.rejects(createClient().listThingCertificates(input), error)
        })

        it('throws an Error when certificate description fails', async function () {
            commandStub('ListThingPrincipalsCommand').resolves(principalsResponse)
            commandStub('DescribeCertificateCommand').rejects(error)

            await assert.rejects(createClient().listThingCertificates(input), error)
        })
    })

    describe('listThingsForCert', function () {
        const input: ListPrincipalThingsRequest = { principal: 'arn1', maxResults, nextToken }
        const listResponse: ListPrincipalThingsResponse = { things: [thingName], nextToken }
        const expectedResponse = [thingName]

        it('lists things', async function () {
            commandStub('ListPrincipalThingsCommand').resolves(listResponse)

            const response = await createClient().listThingsForCert(input)

            assert.deepStrictEqual(response, expectedResponse)
        })

        it('throws an Error on failure', async function () {
            commandStub('ListPrincipalThingsCommand').rejects(error)

            await assert.rejects(createClient().listThingsForCert(input), error)
        })
    })

    describe('listPolicies', function () {
        const input: ListPoliciesRequest = { pageSize, marker, ascendingOrder: undefined }
        const expectedResponse: ListPoliciesResponse = { policies: [{ policyName }], nextMarker: marker }

        it('lists policies', async function () {
            commandStub('ListPoliciesCommand').resolves(expectedResponse)

            const response = await createClient().listPolicies(input)

            assert.deepStrictEqual(response, expectedResponse)
        })

        it('throws an Error on failure', async function () {
            commandStub('ListPoliciesCommand').rejects(error)

            await assert.rejects(createClient().listPolicies(input), error)
        })
    })

    describe('listPrincipalPolicies', function () {
        const input: ListPrincipalPoliciesRequest = {
            pageSize,
            marker,
            ascendingOrder: undefined,
            principal: 'arn1',
        }
        const expectedResponse: ListPoliciesResponse = { policies: [{ policyName }], nextMarker: marker }

        it('lists policies for certificate', async function () {
            commandStub('ListPrincipalPoliciesCommand').resolves(expectedResponse)

            const response = await createClient().listPrincipalPolicies(input)

            assert.deepStrictEqual(response, expectedResponse)
        })

        it('throws an Error on failure', async function () {
            commandStub('ListPrincipalPoliciesCommand').rejects(error)

            await assert.rejects(createClient().listPrincipalPolicies(input), error)
        })
    })

    describe('listPolicyTargets', function () {
        const targets = ['arn1', 'arn2']
        const input: ListTargetsForPolicyRequest = { policyName, pageSize, marker }
        const listResponse: ListTargetsForPolicyResponse = { targets, nextMarker: marker }

        it('lists certificates', async function () {
            commandStub('ListTargetsForPolicyCommand').resolves(listResponse)

            const response = await createClient().listPolicyTargets(input)

            assert.deepStrictEqual(response, targets)
        })

        it('throws an Error on failure', async function () {
            commandStub('ListTargetsForPolicyCommand').rejects(error)

            await assert.rejects(createClient().listPolicyTargets(input), error)
        })
    })

    describe('listPolicyVersions', function () {
        const input: ListPolicyVersionsRequest = { policyName }
        const expectedVersion1: PolicyVersion = { versionId: '1' }
        const expectedVersion2: PolicyVersion = { versionId: '2' }
        const listResponse: ListPolicyVersionsResponse = { policyVersions: [expectedVersion1, expectedVersion2] }

        it('lists policy versions', async function () {
            commandStub('ListPolicyVersionsCommand').resolves(listResponse)

            const iterable = createClient().listPolicyVersions(input)
            const responses = []
            for await (const response of iterable) {
                responses.push(response)
            }

            const [firstVersion, secondVersion, ...otherVersions] = responses

            assert.deepStrictEqual(firstVersion, expectedVersion1)
            assert.deepStrictEqual(secondVersion, expectedVersion2)
            assert.deepStrictEqual(otherVersions, [])
        })

        it('throws an Error on iterate failure', async function () {
            commandStub('ListPolicyVersionsCommand').rejects(error)

            const iterable = createClient().listPolicyVersions(input)
            await assert.rejects(iterable.next(), error)
        })
    })
})
