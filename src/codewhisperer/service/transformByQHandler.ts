/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { transformByQState, TransformByQStoppedError, ZipManifest } from '../models/model'
import * as codeWhisperer from '../client/codewhisperer'
import * as crypto from 'crypto'
import { getLogger } from '../../shared/logger'
import { CreateUploadUrlResponse } from '../client/codewhispereruserclient'
import { sleep } from '../../shared/utilities/timeoutUtils'
import * as CodeWhispererConstants from '../models/constants'
import * as fs from 'fs-extra'
import * as path from 'path'
import * as os from 'os'
import * as vscode from 'vscode'
import { spawnSync } from 'child_process'
import AdmZip from 'adm-zip'
import fetch from '../../common/request'
import globals from '../../shared/extensionGlobals'
import { telemetry } from '../../shared/telemetry/telemetry'
import { ToolkitError } from '../../shared/errors'
import { codeTransformTelemetryState } from '../../amazonqGumby/telemetry/codeTransformTelemetryState'

/* TODO: once supported in all browsers and past "experimental" mode, use Intl DurationFormat:
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DurationFormat#browser_compatibility
 * Current functionality: given number of milliseconds elapsed (ex. 4,500,000) return hr / min / sec it represents (ex. 1 hr 15 min)
 */
export function convertToTimeString(durationInMs: number) {
    const duration = durationInMs / CodeWhispererConstants.numMillisecondsPerSecond // convert to seconds
    if (duration < 60) {
        const numSeconds = Math.floor(duration)
        return `${numSeconds} sec`
    } else if (duration < 3600) {
        const numMinutes = Math.floor(duration / 60)
        const numSeconds = Math.floor(duration % 60)
        return `${numMinutes} min ${numSeconds} sec`
    } else {
        const numHours = Math.floor(duration / 3600)
        const numMinutes = Math.floor((duration % 3600) / 60)
        return `${numHours} hr ${numMinutes} min`
    }
}

export function convertDateToTimestamp(date: Date) {
    return date.toLocaleDateString('en-US', {
        month: '2-digit',
        day: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    })
}

export function throwIfCancelled() {
    if (transformByQState.isCancelled()) {
        throw new TransformByQStoppedError()
    }
}

export async function getOpenProjects() {
    const folders = vscode.workspace.workspaceFolders
    if (folders === undefined) {
        vscode.window.showErrorMessage(CodeWhispererConstants.noSupportedJavaProjectsFoundMessage, { modal: true })
        throw new ToolkitError('No Java projects found since no projects are open', { code: 'NoOpenProjects' })
    }
    const openProjects: vscode.QuickPickItem[] = []
    for (const folder of folders) {
        openProjects.push({
            label: folder.name,
            description: folder.uri.fsPath,
        })
    }
    return openProjects
}

/*
 * This function searches for a .class file in the selected project. Then it runs javap on the found .class file to get the JDK version
 * for the project, and sets the version in the state variable. Only JDK8 and JDK11 are supported. It also ensure a pom.xml file is found,
 * since only the Maven build system is supported for now.
 */
export async function validateProjectSelection(project: vscode.QuickPickItem) {
    const projectPath = project.description
    const compiledJavaFiles = await vscode.workspace.findFiles(
        new vscode.RelativePattern(projectPath!, '**/*.class'),
        '**/node_modules/**',
        1,
    )
    if (compiledJavaFiles.length < 1) {
        vscode.window.showErrorMessage(CodeWhispererConstants.noSupportedJavaProjectsFoundMessage, { modal: true })
        telemetry.amazonq_codeTransform_isDoubleClickedToTriggerInvalidProject.emit(
            {
                codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
                result: 'Failed',
                reason: 'Unknown',
            },
        )
        throw new ToolkitError('No Java projects found', { code: 'NoJavaProjectsAvailable' })
    }
    const classFilePath = compiledJavaFiles[0].fsPath
    const baseCommand = 'javap'
    const args = ['-v', classFilePath]
    const spawnResult = spawnSync(baseCommand, args, { shell: false, encoding: 'utf-8' })

    if (spawnResult.error || spawnResult.status !== 0) {
        vscode.window.showErrorMessage(CodeWhispererConstants.noSupportedJavaProjectsFoundMessage, { modal: true })
        telemetry.amazonq_codeTransform_isDoubleClickedToTriggerInvalidProject.emit({
            codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
            result: 'Failed',
            reason: 'Unknown',
        })
        throw new ToolkitError('Unable to determine Java version', { code: 'CannotDetermineJavaVersion' })
    }
    const majorVersionIndex = spawnResult.stdout.indexOf('major version: ')
    const javaVersion = spawnResult.stdout.slice(majorVersionIndex + 15, majorVersionIndex + 17).trim()
    if (javaVersion === CodeWhispererConstants.JDK8VersionNumber) {
        transformByQState.setSourceJDKVersionToJDK8()
    } else if (javaVersion === CodeWhispererConstants.JDK11VersionNumber) {
        transformByQState.setSourceJDKVersionToJDK11()
    } else {
        vscode.window.showErrorMessage(CodeWhispererConstants.noSupportedJavaProjectsFoundMessage, { modal: true })
        telemetry.amazonq_codeTransform_isDoubleClickedToTriggerInvalidProject.emit({
            codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
            result: 'Failed',
            reason: 'JDK',
        })
        throw new ToolkitError('Project selected is not Java 8 or Java 11', { code: 'UnsupportedJavaVersion' })
    }
    const buildFile = await vscode.workspace.findFiles(
        new vscode.RelativePattern(projectPath!, '**/pom.xml'),
        '**/node_modules/**',
        1,
    )
    if (buildFile.length < 1) {
        await checkIfGradle(projectPath!)
        vscode.window.showErrorMessage(CodeWhispererConstants.noPomXmlFoundMessage, { modal: true })
        telemetry.amazonq_codeTransform_isDoubleClickedToTriggerInvalidProject.emit({
            result: 'Failed',
            reason: 'Gradle',
        })
        throw new ToolkitError('No valid Maven build file found', { code: 'CouldNotFindPomXml' })
    }
    telemetry.amazonq_codeTransform_isDoubleClickedToTriggerUserModal.emit({
        codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
    })
}

export function getSha256(fileName: string) {
    const hasher = crypto.createHash('sha256')
    hasher.update(fs.readFileSync(fileName))
    return hasher.digest('base64')
}

// TODO: later, consider enhancing the S3 client to include this functionality
export async function uploadArtifactToS3(fileName: string, resp: CreateUploadUrlResponse) {
    const sha256 = getSha256(fileName)

    let headersObj = {}
    if (resp.kmsKeyArn === undefined || resp.kmsKeyArn.length === 0) {
        headersObj = {
            'x-amz-checksum-sha256': sha256,
            'Content-Type': 'application/zip',
        }
    } else {
        headersObj = {
            'x-amz-checksum-sha256': sha256,
            'Content-Type': 'application/zip',
            'x-amz-server-side-encryption': 'aws:kms',
            'x-amz-server-side-encryption-aws-kms-key-id': resp.kmsKeyArn,
        }
    }

    await sleep(2000) // pause to give time to recognize potential cancellation
    throwIfCancelled()

    const response = await fetch('PUT', resp.uploadUrl, { body: fs.readFileSync(fileName), headers: headersObj })
        .response
    getLogger().info(`Status from S3 Upload = ${response.status}`)
}

export async function stopJob(jobId: string) {
    telemetry.amazonq_codeTransform_jobIsCancelledByUser.emit({
        codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
    })
    if (jobId !== '') {
        try {
            const startTime = Date.now()
            const response = await codeWhisperer.codeWhispererClient.codeModernizerStopCodeTransformation({
                transformationJobId: jobId,
            })

            telemetry.amazonq_codeTransform_logApiLatency.emit({
                codeTransformApiNames: 'StopTransformation',
                codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
                codeTransformRunTimeLatency: (Date.now() - startTime),
                codeTransformJobId: jobId,
                codeTransformRequestId: response.responseMetadata().requestId(),
            })
        } catch (error) {
            const errorMessage = 'Error stopping job'
            const err = error as Error
            // telemetry.amazonq_codeTransformInvoke.record({
            //     codeTransform_ApiName: 'StopTransformation',
            // })
            telemetry.amazonq_codeTransform_logApiError.emit({
                codeTransformApiNames: 'StopTransformation',
                codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
                codeTransformApiErrorMessage: err.message,
                codeTransformJobId: jobId,
            })
            getLogger().error(errorMessage)
            throw new ToolkitError(errorMessage, { cause: err })
        }
    }
}

export async function uploadPayload(payloadFileName: string) {
    const sha256 = getSha256(payloadFileName)
    await sleep(2000) // pause to give time to recognize potential cancellation
    throwIfCancelled()
    let response = null
    const startTime = Date.now()
    try {
        response = await codeWhisperer.codeWhispererClient.createUploadUrl({
            contentChecksum: sha256,
            contentChecksumType: CodeWhispererConstants.contentChecksumType,
            uploadIntent: CodeWhispererConstants.uploadIntent,
        })
        telemetry.amazonq_codeTransform_logApiLatency.emit({
            codeTransformApiNames: 'CreateUploadUrl',
            codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
            codeTransformRunTimeLatency: Date.now() - startTime,
            codeTransformUploadId: codeTransformTelemetryState.getSessionId(),
        })
    } catch (error) {
        const err = error as Error
        telemetry.amazonq_codeTransform_logApiError.emit({
            codeTransformApiErrorMessage: err.message,
            codeTransformApiNames: 'CreateUploadUrl',
            codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
        })
        throw new Error('CreateUploadUrl failed')
    }

    try {
        await uploadArtifactToS3(payloadFileName, response)
    } catch (error) {
        const err = error as Error
        telemetry.amazonq_codeTransform_logApiError.emit({
            codeTransformApiErrorMessage: err.message,
            codeTransformApiNames: 'UploadZip',
            codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
        })
        throw new Error('uploadArtifactToS3 failed')
    }
    return response.uploadId
}

function getFilesRecursively(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    const files = entries.flatMap(entry => {
        const res = path.resolve(dir, entry.name)
        // exclude 'target' directory from ZIP due to issues in backend
        if (entry.isDirectory()) {
            if (entry.name !== 'target') {
                return getFilesRecursively(res)
            } else {
                return []
            }
        } else {
            return [res]
        }
    })
    return files
}

function getProjectDependencies(modulePath: string): string[] {
    // Make temp directory
    const folderName = `${CodeWhispererConstants.dependencyFolderName}${Date.now()}`
    const folderPath = path.join(os.tmpdir(), folderName)

    const baseCommand = 'mvn'
    const args = [
        'dependency:copy-dependencies',
        '-DoutputDirectory=' + folderPath,
        '-Dmdep.useRepositoryLayout=true',
        '-Dmdep.copyPom=true',
        '-Dmdep.addParentPoms=true',
    ]
    const spawnResult = spawnSync(baseCommand, args, { cwd: modulePath, shell: false, encoding: 'utf-8' })

    if (spawnResult.error || spawnResult.status !== 0) {
        vscode.window.showErrorMessage(CodeWhispererConstants.dependencyErrorMessage, { modal: true })
        getLogger().error('Error in running Maven command:')
        // Maven command can still go through and still return an error. Won't be caught in spawnResult.error in this case
        if (spawnResult.error) {
            getLogger().error(spawnResult.error)
        } else {
            getLogger().error(spawnResult.stdout)
        }
        throw new ToolkitError('Maven Dependency Error', { code: 'CannotRunMavenShellCommand' })
    }

    return [folderPath, folderName]
}

export async function zipCode(modulePath: string) {
    await sleep(2000) // pause to give time to recognize potential cancellation
    throwIfCancelled()

    const sourceFolder = modulePath
    const sourceFiles = getFilesRecursively(sourceFolder)

    await sleep(2000) // pause to give time to recognize potential cancellation
    throwIfCancelled()

    let dependencyFolderInfo: string[] = []
    let mavenFailed = false
    try {
        dependencyFolderInfo = getProjectDependencies(modulePath)
    } catch (err) {
        mavenFailed = true
    }

    const dependencyFolderPath = !mavenFailed ? dependencyFolderInfo[0] : ''
    const dependencyFolderName = !mavenFailed ? dependencyFolderInfo[1] : ''

    await sleep(2000) // pause to give time to recognize potential cancellation
    throwIfCancelled()

    const zip = new AdmZip()
    const zipManifest = new ZipManifest()

    for (const file of sourceFiles) {
        const relativePath = path.relative(sourceFolder, file)
        const paddedPath = path.join('sources', relativePath)
        zip.addLocalFile(file, path.dirname(paddedPath))
    }

    await sleep(2000) // pause to give time to recognize potential cancellation
    throwIfCancelled()

    let dependencyFiles: string[] = []
    if (!mavenFailed) {
        dependencyFiles = getFilesRecursively(dependencyFolderPath)
    }

    if (!mavenFailed && dependencyFiles.length > 0) {
        for (const file of dependencyFiles) {
            const relativePath = path.relative(dependencyFolderPath, file)
            const paddedPath = path.join(`dependencies/${dependencyFolderName}`, relativePath)
            zip.addLocalFile(file, path.dirname(paddedPath))
        }
        zipManifest.dependenciesRoot += `${dependencyFolderName}/`
    } else {
        zipManifest.dependenciesRoot = undefined
    }
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(zipManifest), 'utf-8'))

    await sleep(2000) // pause to give time to recognize potential cancellation
    throwIfCancelled()

    const tempFilePath = path.join(os.tmpdir(), 'zipped-code.zip')
    fs.writeFileSync(tempFilePath, zip.toBuffer())
    if (!mavenFailed) {
        fs.rmSync(dependencyFolderPath, { recursive: true, force: true })
    }
    return tempFilePath
}

export async function startJob(uploadId: string) {
    const sourceLanguageVersion = `JAVA_${transformByQState.getSourceJDKVersion()}`
    const targetLanguageVersion = `JAVA_${transformByQState.getTargetJDKVersion()}`
    try {
        const startTime = Date.now()
        const response = await codeWhisperer.codeWhispererClient.codeModernizerStartCodeTransformation({
            workspaceState: {
                uploadId: uploadId,
                programmingLanguage: { languageName: CodeWhispererConstants.defaultLanguage.toLowerCase() },
            },
            transformationSpec: {
                transformationType: CodeWhispererConstants.transformationType,
                source: { language: sourceLanguageVersion },
                target: { language: targetLanguageVersion },
            },
        })
        telemetry.amazonq_codeTransform_logApiLatency.emit({
            codeTransformApiNames: 'StartTransformation',
            codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
            codeTransformRunTimeLatency: (Date.now() - startTime),
            codeTransformUploadId: response.transformationJobId(),
            codeTransformRequestId: response.responseMetadata().requestId(),
        })
        return response.transformationJobId
    } catch (error) {
        const err = error as Error
        telemetry.amazonq_codeTransform_logApiError.emit({
            codeTransformApiNames: 'StartTransformation',
            codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
            codeTransformApiErrorMessage: err.message,
        })
        throw new Error(err.message)
    }
}

export function getImageAsBase64(filePath: string) {
    const fileContents = fs.readFileSync(filePath, { encoding: 'base64' })
    return `data:image/svg+xml;base64,${fileContents}`
}

export async function getTransformationPlan(jobId: string) {
    const startTime = Date.now()
    let response = null
    try {
        response = await codeWhisperer.codeWhispererClient.codeModernizerGetCodeTransformationPlan({
            transformationJobId: jobId,
        })
        telemetry.amazonq_codeTransform_logApiLatency.emit({
            codeTransformApiNames: 'GetTransformationPlan',
            codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
            codeTransformRunTimeLatency: (Date.now() - startTime),
            codeTransformJobId: jobId,
        })
    } catch (error) {
        const err = error as Error
        telemetry.amazonq_codeTransform_logApiError.emit({
            codeTransformApiNames: 'GetTransformationPlan',
            codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
            codeTransformApiErrorMessage: err.message,
            codeTransformJobId: jobId,

        })
        throw new Error(err.message)
    }
    const logoAbsolutePath = globals.context.asAbsolutePath(
        path.join('resources', 'icons', 'aws', 'amazonq', 'transform-landing-page-icon.svg')
    )
    const logoBase64 = getImageAsBase64(logoAbsolutePath)
    let plan = `![Transform by Q](${logoBase64}) \n # Code Transformation Plan by Amazon Q \n\n`
    plan += CodeWhispererConstants.planIntroductionMessage.replace(
        'JAVA_VERSION_HERE',
        transformByQState.getSourceJDKVersion()
    )
    plan += `\n\nExpected total transformation steps: ${response.transformationPlan.transformationSteps.length}\n\n`
    plan += CodeWhispererConstants.planDisclaimerMessage
    for (const step of response.transformationPlan.transformationSteps) {
        plan += `**${step.name}**\n\n- ${step.description}\n\n\n`
    }

    return plan
}

export async function getTransformationSteps(jobId: string) {
    await sleep(2000) // prevent ThrottlingException
    const response = await codeWhisperer.codeWhispererClient.codeModernizerGetCodeTransformationPlan({
        transformationJobId: jobId,
    })
    return response.transformationPlan.transformationSteps
}

export async function pollTransformationJob(jobId: string, validStates: string[]) {
    let status: string = ''
    let timer: number = 0
    let response = null
    while (true) {
        throwIfCancelled()
        try {
            const startTime = Date.now()
            response = await codeWhisperer.codeWhispererClient.codeModernizerGetCodeTransformation({
                transformationJobId: jobId,
            })
            telemetry.amazonq_codeTransform_logApiLatency.emit({
                codeTransformApiNames: 'GetTransformation',
                codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
                codeTransformRunTimeLatency: (Date.now() - startTime),
                codeTransformJobId: jobId,
                codeTransformRequestId: response.responseMetadata().requestId(),
            })
        } catch (error) {
            const err = error as Error
            telemetry.amazonq_codeTransform_logApiError.emit({
                codeTransformApiErrorMessage: err.message,
                codeTransformApiNames: 'GetTransformation',
                codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
                codeTransformJobId: jobId,
            })
            throw new ToolkitError('Error when GetTransformation', { cause: error as Error })
        }
        if (response.transformationJob.reason) {
            transformByQState.setJobFailureReason(response.transformationJob.reason)
        }
        status = response.transformationJob.status!
        transformByQState.setPolledJobStatus(status)
        await vscode.commands.executeCommand('aws.amazonq.refresh')
        if (validStates.includes(status)) {
            break
        }
        if (CodeWhispererConstants.failureStates.includes(status)) {
            throw new Error('Job failed, not going to retrieve plan')
        }
        await sleep(CodeWhispererConstants.transformationJobPollingIntervalSeconds * 1000)
        timer += CodeWhispererConstants.transformationJobPollingIntervalSeconds
        if (timer > CodeWhispererConstants.transformationJobTimeoutSeconds) {
            throw new Error('Transform by Q timed out')
        }
    }
    return status
}

async function checkIfGradle(projectPath: string) {
    const gradleBuildFile = await vscode.workspace.findFiles(
        new vscode.RelativePattern(projectPath, '**/build.gradle'),
        '**/node_modules/**',
        1,
    )

    if (gradleBuildFile.length > 0) {
        telemetry.amazonq_codeTransformInvoke.record({
            codeTransform_ProjectType: 'gradle',
        })
    } else {
        telemetry.amazonq_codeTransformInvoke.record({
            codeTransform_ProjectType: 'unknown',
        })
    }
}
