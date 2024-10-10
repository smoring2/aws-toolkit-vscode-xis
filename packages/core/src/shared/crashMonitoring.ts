/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import path from 'path'
import globals, { isWeb } from './extensionGlobals'
import { getSessionId as _getSessionId } from './telemetry/util'
import { getErrorId, getTelemetryReason, getTelemetryReasonDesc, isFileNotFoundError, ToolkitError } from './errors'
import { isAutomation, isDebugInstance } from './vscode/env'
import { DevSettings } from './settings'
import vscode from 'vscode'
import { telemetry } from './telemetry'
import { Logger } from './logger'
import { isNewOsSession } from './utilities/osUtils'
import nodeFs from 'fs/promises'
import fs from './fs/fs'
import { getLogger } from './logger/logger'
import { crashMonitoringDirNames } from './constants'
import { throwOnUnstableFileSystem } from './filesystemUtilities'
import { withRetries } from './utilities/functionUtils'

const className = 'CrashMonitoring'

/**
 * Handles crash reporting for the extension.
 *
 * ### Pre-requisite knowledge:
 *
 * - If an extension crashes it cannot report that it crashed.
 * - The ExtensionHost is a separate process from the main VS Code editor process where all extensions run in
 * - Read about the [`deactivate()` behavior](../../../../docs/vscode_behaviors.md)
 * - An IDE instance is one instance of VS Code, and Extension Instance is 1 instance of our extension. These are 1:1.
 *
 * ### How it works at a high level:
 *
 * - Each IDE instance will start its own crash monitoring process on startup
 * - The crash monitoring process works with each instance sending heartbeats to a centralized state. Separately each instance
 *   has a "Checker" that checks each heartbeat to see if it is not running anymore, and appropriately handles when needed.
 *
 * - On a crash we will emit a `session_end` metrics with `{ result: 'Failed', reason: 'ExtHostCrashed', crashedSessionId: '...' }`
 * - On successful shutdown  a `session_end` with a successful result is already emitted elsewhere.
 * - IMPORTANT: There is potential for duplicate metrics to be emitted since all Checkers can emit, so for `session_end` with `'Failed'`,
 *   deduplicate by on the key `proxiedSessionId`.
 *
 * - To get the most verbose debug logs, configure the devmode setting: `crashReportInterval`
 *
 * - This entire feature is non critical and should not impede extension usage if something goes wrong. As a result, we
 *   swallow all errors and only log/telemetry issues. This is the reason for all the try/catch statements
 *
 * ### Limitations
 * - We will never truly know if we are the cause of the crash
 *   - Since all extensions run in the same Ext Host process, any one of them could cause it to crash and we wouldn't be
 *     able to differentiate
 * - If the IDE itself crashes, unrelated to the extensions, it will still be seen as a crash in our telemetry
 *   - We are not able to explicitly determine if we were the cause of the crash
 * - If the user shuts down their computer after a crash before the next crash check can run, that info is lost
 *   - We cannot persist crash information on computer restart
 * - We use the users filesystem to maintain the state of running extension instances, but the
 *   filesystem is not reliable and can lead to incorrect crash reports
 *   - To mitigate this we do not run crash reporting on machines that we detect have a flaky filesystem
 */
export class CrashMonitoring {
    protected heartbeat: Heartbeat | undefined
    protected crashChecker: CrashChecker | undefined

    constructor(
        private readonly state: FileSystemState,
        private readonly checkInterval: number,
        private readonly isDevMode: boolean,
        private readonly isAutomation: boolean,
        private readonly devLogger: Logger | undefined
    ) {}

    static #didTryCreate = false
    static #instance: CrashMonitoring | undefined
    /** Returns an instance of this class or undefined if any initial validation fails. */
    public static async instance(): Promise<CrashMonitoring | undefined> {
        // Since the first attempt to create an instance may have failed, we do not
        // attempt to create an instance again and return whatever we have
        if (this.#didTryCreate === true) {
            return this.#instance
        }

        try {
            this.#didTryCreate = true
            const isDevMode = getIsDevMode()
            const devModeLogger: Logger | undefined = isDevMode ? getLogger() : undefined
            const state = await crashMonitoringStateFactory() // can throw
            return (this.#instance ??= new CrashMonitoring(
                state,
                DevSettings.instance.get('crashCheckInterval', 1000 * 60 * 10), // check every 10 minutes
                isDevMode,
                isAutomation(),
                devModeLogger
            ))
        } catch (error) {
            emitFailure({ functionName: 'instance', error })
            return undefined
        }
    }

    /** Start the Crash Monitoring process */
    public async start() {
        if (isWeb()) {
            return
        }

        // During tests, the Prod code also runs this function. It interferes with telemetry assertion since it reports additional heartbeats.
        if (this.isAutomation) {
            return
        }

        try {
            this.heartbeat = new Heartbeat(this.state, this.checkInterval, this.isDevMode)
            this.crashChecker = new CrashChecker(this.state, this.checkInterval, this.isDevMode, this.devLogger)

            await this.heartbeat.start()
            await this.crashChecker.start()
        } catch (error) {
            emitFailure({ functionName: 'start', error })
            try {
                this.crashChecker?.cleanup()
                await this.heartbeat?.cleanup()
            } catch {}

            // Surface errors during development, otherwise it can be missed.
            if (this.isDevMode) {
                throw error
            }
        }
    }

    /** Stop the Crash Monitoring process, signifying a graceful shutdown */
    public async shutdown() {
        try {
            this.crashChecker?.cleanup()
            await this.heartbeat?.shutdown()
        } catch (error) {
            try {
                // This probably wont emit in time before shutdown, but may be written to the logs
                emitFailure({ functionName: 'stop', error })
            } catch {}

            if (this.isDevMode) {
                throw error
            }
        }
    }
}

/**
 * Heartbeats that indicate the extension instance is still running.
 * {@link CrashChecker} listens for these.
 */
class Heartbeat {
    private intervalRef: NodeJS.Timer | undefined
    constructor(
        private readonly state: FileSystemState,
        private readonly checkInterval: number,
        private readonly isDevMode: boolean
    ) {}

    public async start() {
        const heartbeatInterval = this.checkInterval / 2

        // Send an initial heartbeat immediately
        await withFailCtx('initialSendHeartbeat', () => this.state.sendHeartbeat())

        // Send a heartbeat every interval
        this.intervalRef = globals.clock.setInterval(async () => {
            try {
                await this.state.sendHeartbeat()
            } catch (e) {
                try {
                    await this.cleanup()
                    emitFailure({ functionName: 'sendHeartbeatInterval', error: e })
                } catch {}

                if (this.isDevMode) {
                    throw e
                }
            }
        }, heartbeatInterval)
    }

    /** Stops everything, signifying a graceful shutdown */
    public async shutdown() {
        globals.clock.clearInterval(this.intervalRef)
        return this.state.indicateGracefulShutdown()
    }

    /**
     * Safely attempts to clean up this heartbeat from the state to try and avoid
     * an incorrectly indicated crash. Use this on failures.
     *
     * ---
     *
     * IMPORTANT: This function must not throw as this function is run within a catch
     */
    public async cleanup() {
        try {
            await this.shutdown()
        } catch {}
        try {
            await this.state.clearHeartbeat()
        } catch {}
    }

    /** Mimics a crash, only for testing */
    public testCrash() {
        globals.clock.clearInterval(this.intervalRef)
    }
}

/**
 * This checks the heartbeats of each known extension to see if it has crashed and handles that result appropriately.
 */
class CrashChecker {
    private intervalRef: NodeJS.Timer | undefined

    constructor(
        private readonly state: FileSystemState,
        private readonly checkInterval: number,
        private readonly isDevMode: boolean,
        private readonly devLogger: Logger | undefined
    ) {}

    public async start() {
        {
            this.devLogger?.debug(`crashMonitoring: checkInterval ${this.checkInterval}`)

            // do an initial check
            await withFailCtx('initialCrashCheck', () =>
                tryCheckCrash(this.state, this.checkInterval, this.isDevMode, this.devLogger)
            )

            // check on an interval
            this.intervalRef = globals.clock.setInterval(async () => {
                try {
                    await tryCheckCrash(this.state, this.checkInterval, this.isDevMode, this.devLogger)
                } catch (e) {
                    emitFailure({ functionName: 'checkCrashInterval', error: e })
                    this.cleanup()

                    if (this.isDevMode) {
                        throw e
                    }
                }
            }, this.checkInterval)
        }

        // ------------ Inner Functions ------------

        async function tryCheckCrash(
            state: FileSystemState,
            checkInterval: number,
            isDevMode: boolean,
            devLogger: Logger | undefined
        ) {
            // Iterate all known extensions and for each check if they have crashed
            const knownExts = await state.getAllExts()
            const runningExts: ExtInstanceHeartbeat[] = []
            for (const ext of knownExts) {
                if (!isStoppedHeartbeats(ext, checkInterval)) {
                    runningExts.push(ext)
                    continue
                }

                // Ext is not running anymore, handle appropriately depending on why it stopped running
                await state.handleExtNotRunning(ext, {
                    onShutdown: async () => {
                        // Nothing to do, just log info if necessary
                        devLogger?.debug(
                            `crashMonitoring: SHUTDOWN: following has gracefully shutdown: pid ${ext.extHostPid} + sessionId: ${ext.sessionId}`
                        )
                    },
                    onCrash: async () => {
                        // Debugger instances may incorrectly look like they crashed, so don't emit.
                        // Example is if I hit the red square in the debug menu, it is a non-graceful shutdown. But the regular
                        // 'x' button in the Debug IDE instance is a graceful shutdown.
                        if (ext.isDebug) {
                            devLogger?.debug(`crashMonitoring: DEBUG instance crashed: ${JSON.stringify(ext)}`)
                            return
                        }

                        // This is the metric to let us know the extension crashed
                        telemetry.session_end.emit({
                            result: 'Failed',
                            proxiedSessionId: ext.sessionId,
                            reason: 'ExtHostCrashed',
                            passive: true,
                        })

                        devLogger?.debug(
                            `crashMonitoring: CRASH: following has crashed: pid ${ext.extHostPid} + sessionId: ${ext.sessionId}`
                        )
                    },
                })
            }

            if (isDevMode) {
                const before = knownExts.map((i) => i.extHostPid)
                const after = runningExts.map((i) => i.extHostPid)
                // Sanity check: ENSURE THAT AFTER === ACTUAL or this implies that our data is out of sync
                const afterActual = (await state.getAllExts()).map((i) => i.extHostPid)
                devLogger?.debug(
                    `crashMonitoring: CHECKED: Result of cleaning up stopped instances\nBEFORE: ${JSON.stringify(before)}\nAFTER:  ${JSON.stringify(after)}\nACTUAL: ${JSON.stringify(afterActual)}`
                )
            }

            return
        }

        function isStoppedHeartbeats(ext: ExtInstanceHeartbeat, checkInterval: number) {
            const millisSinceLastHeartbeat = globals.clock.Date.now() - ext.lastHeartbeat
            return millisSinceLastHeartbeat >= checkInterval
        }
    }

    /** Use this on failures to terminate the crash checker */
    public cleanup() {
        globals.clock.clearInterval(this.intervalRef)
    }

    /** Mimics a crash, only for testing */
    public testCrash() {
        globals.clock.clearInterval(this.intervalRef)
    }
}

/**
 * We define this externally so that we have a single source of truth for the contructor args.
 * Ideally we'd use ConstructorParameters, but it does not work when the constructor is protected.
 */
type MementoStateDependencies = {
    memento: vscode.Memento
    pid: number
    sessionId: string
    workDirPath: string
    isDevMode: boolean
    isStateStale: () => Promise<boolean>
    now: () => number
    devLogger: Logger | undefined
}

function getDefaultDependencies(): MementoStateDependencies {
    return {
        now: () => globals.clock.Date.now(),
        workDirPath: path.join(globals.context.globalStorageUri.fsPath),
        memento: globals.globalState as vscode.Memento,
        isStateStale: () => isNewOsSession(),
        pid: process.pid,
        sessionId: _getSessionId(),
        isDevMode: getIsDevMode(),
        devLogger: getIsDevMode() ? getLogger() : undefined,
    }
}
/**
 * Factory to create an instance of the state.
 *
 * @throws if the filesystem state cannot be confirmed to be stable, i.e flaky fs operations
 */
export async function crashMonitoringStateFactory(deps = getDefaultDependencies()): Promise<FileSystemState> {
    const state: FileSystemState = new FileSystemState(deps)
    await state.init()
    return state
}

/**
 * The state of all running extensions.
 * - is globally shared with all other extension instances.
 * - uses the File System
 *   - is not truly reliable since filesystems are not reliable
 */
export class FileSystemState {
    private readonly stateDirPath: string

    /**
     * IMORTANT: Use {@link crashMonitoringStateFactory} to make an instance
     */
    constructor(protected readonly deps: MementoStateDependencies) {
        this.stateDirPath = path.join(this.deps.workDirPath, crashMonitoringDirNames.root)

        this.deps.devLogger?.debug(`crashMonitoring: pid: ${this.deps.pid}`)
        this.deps.devLogger?.debug(`crashMonitoring: sessionId: ${this.deps.sessionId.slice(0, 8)}-...`)
        this.deps.devLogger?.debug(`crashMonitoring: dir: ${this.stateDirPath}`)
    }

    /**
     * Does the required initialization steps, this must always be run after
     * creation of the instance.
     *
     * @throws if the filesystem state cannot be confirmed to be stable, i.e flaky fs operations
     */
    public async init() {
        // IMPORTANT: do not run crash reporting on unstable filesystem to reduce invalid crash data
        //
        // NOTE: Emits a metric to know how many clients we skipped
        await telemetry.function_call.run(async (span) => {
            span.record({ className, functionName: 'FileSystemStateValidation' })
            await withFailCtx('validateFileSystemStability', () => throwOnUnstableFileSystem())
        })

        // Clear the state if the user did something like a computer restart
        if (await this.deps.isStateStale()) {
            await this.clearState()
        }
    }

    // ------------------ Heartbeat methods ------------------
    public async sendHeartbeat() {
        const extId = this.createExtId(this.ext)

        try {
            const func = async () => {
                const dir = await this.runningExtsDir()
                await fs.writeFile(
                    path.join(dir, extId),
                    JSON.stringify({ ...this.ext, lastHeartbeat: this.deps.now() }, undefined, 4)
                )
                this.deps.devLogger?.debug(
                    `crashMonitoring: HEARTBEAT pid ${this.deps.pid} + sessionId: ${this.deps.sessionId.slice(0, 8)}-...`
                )
            }
            const funcWithCtx = () => withFailCtx('sendHeartbeatState', func)
            const funcWithRetries = withRetries(funcWithCtx, { maxRetries: 8, delay: 100, backoff: 2 })
            return await funcWithRetries
        } catch (e) {
            // delete this ext from the state to avoid an incorrectly reported crash since we could not send a new heartbeat
            await withFailCtx('sendHeartbeatFailureCleanup', () => this.clearHeartbeat())
            throw e
        }
    }
    /** Clears this extentions heartbeat from the state */
    public async clearHeartbeat() {
        await this.deleteHeartbeatFile(this.extId)
    }

    /**
     * Signal that this extension is gracefully shutting down. This will prevent the IDE from thinking it crashed.
     *
     * IMPORTANT: This code is being run in `deactivate()` where VS Code api is not available. Due to this we cannot
     * easily update the state to indicate a graceful shutdown. So the next best option is to write to a file on disk,
     * and its existence indicates a graceful shutdown.
     *
     * IMPORTANT: Since the VSC FileSystem api is not available during deactivation we MUST use Node FS in anything this
     * function touches.
     */
    public async indicateGracefulShutdown(): Promise<void> {
        const dir = await this.shutdownExtsDir()
        await withFailCtx('writeShutdownFile', () => nodeFs.writeFile(path.join(dir, this.extId), ''))
    }

    // ------------------ Checker Methods ------------------

    /**
     * Signals the state that the given extension is not running, allowing the state to appropriately update
     * depending on a graceful shutdown or crash.
     *
     * NOTE: This does NOT run in the `deactivate()` method, so it CAN reliably use the VS Code FS api
     *
     * @param opts - functions to run depending on why the extension stopped running
     */
    public async handleExtNotRunning(
        ext: ExtInstance,
        opts: { onShutdown: () => Promise<void>; onCrash: () => Promise<void> }
    ): Promise<void> {
        const extId = this.createExtId(ext)
        const shutdownFilePath = path.join(await this.shutdownExtsDir(), extId)

        if (await withFailCtx('existsShutdownFile', () => fs.exists(shutdownFilePath))) {
            await opts.onShutdown()
            // We intentionally do not clean up the file in shutdown since there may be another
            // extension may be doing the same thing in parallel, and would read the extension as
            // crashed since the file was missing. The file  will be cleared on computer restart though.

            // TODO: Be smart and clean up the file after some time.
        } else {
            await opts.onCrash()
        }

        // Clean up the running extension file since it no longer exists
        await this.deleteHeartbeatFile(extId)
    }
    public async deleteHeartbeatFile(extId: ExtInstanceId) {
        const dir = await this.runningExtsDir()
        // Retry file deletion to prevent incorrect crash reports. Common Windows errors seen in telemetry: EPERM/EBUSY.
        // See: https://github.com/aws/aws-toolkit-vscode/pull/5335
        await withRetries(() => withFailCtx('deleteStaleRunningFile', () => fs.delete(path.join(dir, extId))), {
            maxRetries: 8,
            delay: 100,
            backoff: 2,
        })
    }

    // ------------------ State data ------------------
    public get extId(): ExtInstanceId {
        return this.createExtId(this.ext)
    }
    /** This extensions metadata */
    protected get ext(): ExtInstance {
        return {
            sessionId: this.deps.sessionId,
            extHostPid: this.deps.pid,
            isDebug: isDebugInstance() ? true : undefined,
        }
    }
    /**
     * Returns a value that uniquely identifies an Extension Instance.
     *
     * - When an ExtHost crashes the VSCode instance itself does not crash, this means the session ID stays the
     *   same. This is the current behavior of vscode's sessionId api that we use under the hood (verified manually).
     * - The Extension Host PID used in addition to the session ID should be good enough to uniquely identiy.
     */
    protected createExtId(ext: ExtInstance): ExtInstanceId {
        return `${ext.extHostPid}_${ext.sessionId}`
    }
    private async runningExtsDir(): Promise<string> {
        const p = path.join(this.stateDirPath, crashMonitoringDirNames.running)
        // ensure the dir exists
        await withFailCtx('ensureRunningExtsDir', () => nodeFs.mkdir(p, { recursive: true }))
        return p
    }
    private async shutdownExtsDir() {
        const p = path.join(this.stateDirPath, crashMonitoringDirNames.shutdown)
        // Since this runs in `deactivate()` it cannot use the VS Code FS api
        await withFailCtx('ensureShutdownExtsDir', () => nodeFs.mkdir(p, { recursive: true }))
        return p
    }
    public async clearState(): Promise<void> {
        this.deps.devLogger?.debug('crashMonitoring: CLEAR_STATE: Started')
        await withFailCtx('clearState', async () => {
            await fs.delete(this.stateDirPath, { force: true, recursive: true })
            this.deps.devLogger?.debug('crashMonitoring: CLEAR_STATE: Succeeded')
        })
    }
    public async getAllExts(): Promise<ExtInstanceHeartbeat[]> {
        const res = await withFailCtx('getAllExts', async () => {
            // The file names are intentionally the IDs for easy mapping
            const allExtIds: ExtInstanceId[] = await withFailCtx('readdir', async () =>
                (await fs.readdir(await this.runningExtsDir())).map((k) => k[0])
            )

            const allExts = allExtIds.map<Promise<ExtInstanceHeartbeat | undefined>>(async (extId: string) => {
                // Due to a race condition, a separate extension instance may have removed this file by this point. It is okay since
                // we will assume that other instance handled its termination appropriately.
                // NOTE: On Windows we were failing on EBUSY, so we retry on failure.
                const ext: ExtInstanceHeartbeat | undefined = await withRetries(
                    () =>
                        withFailCtx('parseRunningExtFile', async () =>
                            ignoreBadFileError(async () => {
                                const text = await fs.readFileText(path.join(await this.runningExtsDir(), extId))

                                if (!text) {
                                    return undefined
                                }

                                // This was sometimes throwing SyntaxError
                                return JSON.parse(text) as ExtInstanceHeartbeat
                            })
                        ),
                    { maxRetries: 6, delay: 100, backoff: 2 }
                )

                if (ext === undefined) {
                    return
                }

                if (!isExtHeartbeat(ext)) {
                    throw new CrashMonitoringError(`Unexpected result from state for ext with key, ${extId}: ${ext}`)
                }
                return ext
            })
            // filter out undefined before returning
            const result = (await Promise.all(allExts)).filter<ExtInstanceHeartbeat>(isExtHeartbeat)
            return result
        })
        return res
    }
}

/**
 * Runs the given callback, returning undefined in the case a common file operation
 * error occured
 */
async function ignoreBadFileError<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
        return await fn()
    } catch (e) {
        if (isFileNotFoundError(e) || (e instanceof Error && getErrorId(e) === 'SyntaxError')) {
            return undefined
        }
        throw e
    }
}

/**
 * Returns true if the context this is being run in is development.
 * Enabling dev mode will slightly change behavior:
 * - Adding more verbose debug logs
 * - throwing errors, when typically in prod they would be swallowed
 */
function getIsDevMode() {
    return DevSettings.instance.get('crashCheckInterval', -1) !== -1
}

type ExtInstanceId = string

/** The static metadata of an instance of this extension */
export type ExtInstance = {
    extHostPid: number
    sessionId: string
    lastHeartbeat?: number
    /**
     * True if this instance was being run in a `Run & Debug` VS Code instance.
     */
    isDebug?: boolean
}

type ExtInstanceHeartbeat = ExtInstance & { lastHeartbeat: number }

function isExtHeartbeat(ext: unknown): ext is ExtInstanceHeartbeat {
    return typeof ext === 'object' && ext !== null && 'lastHeartbeat' in ext && ext.lastHeartbeat !== undefined
}

// Use this error for all crash reporting as it gives context to this feature
const CrashMonitoringError = ToolkitError.named(className)

/**
 * Executes the given function, and wraps and throw exceptions with relevant context.
 * This is helpful in telemetry as it gives more context about the error since we do not
 * have a stacktrace there.
 */
async function withFailCtx<T>(ctx: string, fn: () => Promise<T>): Promise<T> {
    try {
        // make sure we await the function so it actually executes within the try/catch
        return await fn()
    } catch (err) {
        throw CrashMonitoringError.chain(err, `Context: "${ctx}"`, { code: className })
    }
}

/** Emits a metric for the given failure, but wraps it with relevant context. */
function emitFailure(args: { functionName: string; error: unknown }) {
    telemetry.function_call.emit({
        className,
        functionName: args.functionName,
        result: 'Failed',
        reason: getTelemetryReason(args.error),
        reasonDesc: getTelemetryReasonDesc(args.error),
        passive: true,
    })
}
