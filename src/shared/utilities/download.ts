/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path'
import fs from 'fs-extra'
import {
    CodeWhispererStreaming,
    ExportResultArchiveCommandInput,
} from '@amzn/codewhisperer-streaming'
import { ToolkitError } from '../errors'
import { telemetry } from '../telemetry/telemetry'
import {
    codeTransformTelemetryState,
} from '../../amazonqGumby/telemetry/codeTransformTelemetryState'
import { Any } from './typeConstructors'

/**
 * This class represents the structure of the archive returned by the ExportResultArchive endpoint
 */
export class ExportResultArchiveStructure {
    static readonly PathToSummary = path.join('summary', 'summary.md')
    static readonly PathToDiffPatch = path.join('patch', 'diff.patch')
    static readonly PathToSourceDir = 'sources'
    static readonly PathToManifest = 'manifest.json'
}

export async function downloadExportResultArchive(
    cwStreamingClient: CodeWhispererStreaming,
    exportResultArchiveArgs: ExportResultArchiveCommandInput,
    toPath: string,
) {
    let result = null
    const startTime = Date.now()
    let endTime: number
    try {
        result = await cwStreamingClient.exportResultArchive(exportResultArchiveArgs)
    } catch (error) {
        const err = error as Error
        telemetry.amazonq_codeTransform_logApiError.emit({
            codeTransformApiNames: 'StartTransformation',
            codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
            codeTransformApiErrorMessage: err.message,
            codeTransformJobId: ExportResultArchiveCommandInput.exportId,
        })
        throw new ToolkitError(err.message, { cause: err })
    } finally {
        endTime = Date.now()
    }

    const buffer = []

    if (result.body === undefined) {
        throw new ToolkitError('Empty response from CodeWhisperer Streaming service.')
    }
    let totalDownloadBytes = 0
    for await (const chunk of result.body) {
        if (chunk.binaryPayloadEvent) {
            const chunkData = chunk.binaryPayloadEvent
            if (chunkData.bytes) {
                buffer.push(chunkData.bytes)
                totalDownloadBytes += chunkData.bytes.size
            }
        }
    }
    telemetry.amazonq_codeTransform_logApiLatency.emit({
        codeTransformApiNames: 'ExportResultArchive',
        codeTransformSessionId: codeTransformTelemetryState.getSessionId(),
        codeTransformRunTimeLatency: endTime - startTime,
        codeTransformJobId: ExportResultArchiveCommandInput.exportId,
        codeTransformUploadZipSize: totalDownloadBytes,
    })

    fs.outputFileSync(toPath, Buffer.concat(buffer))
}
