/**
 * The English message catalogue.
 *
 * This file is the **type source** for the whole i18n layer: `MessageKey` is
 * `keyof typeof en`, so a key that does not exist here is a compile error at the
 * call site. That is why the catalogue is a TypeScript module and not JSON -- a
 * JSON file would need a separate type generation step, and until that step ran
 * a typo in `t()` would be a runtime string.
 *
 * Key rules: a namespace from a closed set, then two to four
 * `lowerCamelCase` segments. The four-segment ceiling is deliberate: a deeper
 * path means the sentence should be composed from smaller pieces, not addressed
 * by a longer id.
 *
 * Values are ICU MessageFormat. Named arguments only -- positional arguments are
 * banned because they make a translation reorder silently wrong.
 */

import type { LocaleMessages } from "../types.js";

/** The English catalogue. Also the shape all other catalogues must match. */
export const en = {
  // ---------------------------------------------------------------- common
  "common.action.cancel": "Cancel",
  "common.action.confirm": "Confirm",
  "common.action.delete": "Delete",
  "common.action.save": "Save",
  "common.state.loading": "Loading",
  "common.state.empty": "Nothing here yet",
  "common.state.error": "Something went wrong",

  // ----------------------------------------------------------------- crash
  // The full-window surface that replaces the shell after an engine or renderer
  // death. The two detail messages carry the facts the user needs to report it;
  // the generic description is what an unrecognised route shows.
  "common.crash.engineTitle": "The engine stopped unexpectedly",
  "common.crash.rendererTitle": "The interface stopped",
  "common.crash.description":
    "The application stopped because a process it depends on ended unexpectedly. Exporting a diagnostics bundle is the best way to report what happened.",
  "common.crash.engineDetails":
    "The engine exited with code {code} (signal {signal}). The diagnostics bundle contains the details.",
  "common.crash.rendererDetails":
    "The interface process stopped (reason {reason}, exit code {exitCode}). The diagnostics bundle contains the details.",
  "common.crash.export": "Export diagnostics",
  "common.crash.restart": "Restart application",
  "common.crash.quit": "Quit application",
  "common.crash.bridgeUnavailable":
    "The diagnostics bridge is unavailable, so this action cannot run.",
  "common.crash.notAvailable": "not reported",
  "common.crash.watchdogNotActive":
    "The engine watchdog was not confirmed active ({state}); see the diagnostics bundle.",

  // ----------------------------------------------------------------- about
  // The about window's own copy. The five update results are five sentences
  // rather than one sentence and a flag, because "there is no newer version",
  // "GitHub refused" and "GitHub could not be reached" are three different
  // answers and a user who reads any of them as the first is being misled.
  //
  // `rateLimitHint` is a line of its own: the first sentence says the check
  // failed, and the second says why the reader cannot fix it by retrying now.
  "common.about.title": "About Haruyuki",
  "common.about.version": "Software version",
  "common.about.engine": "Engine",
  "common.about.engineVersion": "Engine version",
  "common.about.engineSource": "Engine source",
  "common.about.sourceBundled": "Bundled with the application",
  "common.about.sourceExternal": "Chosen by you",
  "common.about.sourcePath": "Found on PATH",
  "common.about.lastResult": "Last verification",
  "common.about.lastResultOk": "Passed",
  "common.about.lastResultEntryMismatch": "Entry hash mismatch",
  "common.about.lastResultTreeMismatch": "Tree hash mismatch",
  "common.about.lastResultMissing": "Not checked",
  "common.about.lastResultUnknown": "Not checked",
  "common.about.license": "License",
  "common.about.licenseLine": "Released under the Apache License 2.0.",
  "common.about.openLicense": "Open LICENSE",
  "common.about.openNotice": "Open NOTICE",
  "common.about.openThirdParty": "Open THIRD-PARTY",
  "common.about.repo": "Repository",
  "common.about.repoUrl": "Address",
  "common.about.issue": "Report an issue",
  "common.about.environment": "Environment",
  "common.about.platform": "System",
  "common.about.arch": "Architecture",
  "common.about.electron": "Electron",
  "common.about.node": "Node",
  "common.about.checkUpdate": "Check for updates",
  "common.about.update.checking": "Checking…",
  "common.about.update.available": "Version v{latest} is available (current v{current})",
  "common.about.update.upToDate": "You are up to date (v{current})",
  "common.about.update.openPage": "Open the download page",
  "common.about.update.failedRateLimit": "Check failed: the update quota is exhausted",
  "common.about.update.rateLimitHint":
    "Unauthenticated requests are limited to 60 per hour per egress IP; try again later",
  "common.about.update.failedNetwork": "Check failed: GitHub could not be reached",
  "common.about.update.noRelease": "This software has not been released through any channel yet",
  "common.about.openFailed": "The file could not be opened: {detail}",
  "common.about.unavailable": "Not available",
  "common.about.bridgeUnavailable":
    "The application bridge is unavailable, so this window cannot show the facts it needs.",

  // ------------------------------------------------------------ diagnostics
  // The panel's own vocabulary. The two option labels carry their scope and risk
  // in the same sentence rather than in a tooltip: what a checkbox includes is
  // the one thing a user must not have to go looking for.
  "common.diagnostics.title": "Export diagnostics",
  "common.diagnostics.sessionContent":
    "Include the most recent 200 messages from this session (tool names, arguments and results; never API keys or tokens)",
  "common.diagnostics.minidump":
    "Include the crash dump (minidump); it may contain sensitive data from memory",
  "common.diagnostics.export": "Export",
  "common.diagnostics.cancel": "Cancel",
  "common.diagnostics.close": "Close",
  "common.diagnostics.noSession": "No active session",
  "common.diagnostics.emptySessionNote":
    "This build has no session source, so the bundle will contain an empty placeholder with a note saying so",
  "common.diagnostics.phaseCollect": "Collecting files",
  "common.diagnostics.phaseCompress": "Compressing the bundle",
  "common.diagnostics.phaseWrite": "Writing the archive",
  "common.diagnostics.progress": "Working: {done} of {total}",
  "common.diagnostics.exported": "Exported to {path} ({size} bytes)",
  "common.diagnostics.failed": "Export failed",
  "common.diagnostics.saveTitle": "Save diagnostic bundle",
  "common.diagnostics.zipFilter": "Zip archive",
  "common.diagnostics.capTitle": "Diagnostic bundle is larger than 50 MB",
  "common.diagnostics.capMessage": "The bundle would be {size}, over the {limit} limit.",
  "common.diagnostics.capFull": "Save everything",
  "common.diagnostics.capReduce": "Reduce to the limit",
  "common.diagnostics.successTitle": "Diagnostics exported",
  "common.diagnostics.successMessage": "Saved {size} to {path}",
  "common.diagnostics.openFolder": "Open folder",
  "common.diagnostics.retry": "Retry",
  "common.diagnostics.bridgeUnavailable":
    "The diagnostics bridge is unavailable, so the bundle cannot be exported",

  // ------------------------------------------------------------------ menu
  // The Help menu is the shell's one application-specific menu. Its labels are
  // keys like any renderer string: the menu and the two dialogs it opens must
  // not disagree about a word, and the cleanup count belongs in the label a
  // user reads rather than only in the dialog.
  "common.menu.title": "Help",
  "common.menu.exportDiagnostics": "Export Diagnostics…",
  "common.menu.openLogs": "Open Logs Folder",
  "common.menu.restart": "Restart Application",
  "common.menu.cleanupStale": "Clean Up Leftover Engines…",
  "common.menu.cleanupStaleCount": "Clean Up Leftover Engines ({count})…",
  "common.menu.cleanupTitle": "Leftover engine processes",
  "common.menu.cleanupMessage":
    "{count} engine process(es) from an earlier run could not be identified with confidence. Check each one before ending it:\n\n{details}",
  "common.menu.cleanupConfirm": "End Processes",
  "common.menu.cleanupCancel": "Cancel",
  "common.menu.cleanupDone": "Ended {count} leftover engine process(es).",
  "common.menu.cleanupFailed": "Some leftover processes could not be ended.",
  "common.menu.openLogsFailed": "The logs folder could not be opened.",
  // The one way into the about window. "Check for updates" is the button inside
  // that window (`common.about.checkUpdate`), not a second menu item.
  "common.menu.about": "About Haruyuki",

  // ------------------------------------------------------------- component
  "component.input.placeholder": "Enter a value",
  "component.select.placeholder": "Select an option",
  "component.select.empty": "No matching options",
  "component.dialog.title": "Confirm",
  "component.dialog.close": "Close dialog",
  "component.tag.remove": "Remove",
  "component.alert.dismiss": "Dismiss alert",
  "component.form.required": "This field is required",

  // ------------------------------------------------------- terminal panel
  // The panel's own copy. Two of these are not decoration: the phase sentences
  // are the only place the user learns whether a process died or never started,
  // and the paste sentences are the only warning before several commands run.
  //
  // `phaseIdleOffline` and `phaseIdleReady` are two keys for one phase on
  // purpose. "Idle" means both "nothing has been asked of the engine yet" and
  // "the connection came back and you may start again"; one sentence covering
  // both tells a user who just lost a shell that they never had one.
  "component.terminal.phaseIdleOffline": "Not connected to the engine",
  // Two notices rather than two phases: neither of these is a fact about a
  // session. The first says the channel is down and a retry may work; the second
  // says this build does not have the capability and a retry cannot.
  // The marker painted into the terminal when the peer dropped bytes for it. A
  // catalogue key rather than a literal, because the sink is told it can supply
  // no text of its own: the word for "omitted" belongs here.
  "component.terminal.droppedBytes": "[omitted {bytes} bytes]",
  "component.terminal.noticeChannelUnavailable": "Cannot reach the engine right now",
  "component.terminal.noticeNotImplemented": "This is not available in this build yet",
  "component.terminal.phaseIdleReady": "Connection restored; reopen to start a new session",
  "component.terminal.phaseStarting": "Starting the shell",
  "component.terminal.phaseRunning": "Running",
  "component.terminal.phaseExited": "Exited with code {code}",
  // `{detail}` is the engine's own untranslated text, placed in a sentence we
  // own: the engine knows why the spawn failed, this catalogue knows how to ask.
  "component.terminal.phaseFailed": "The shell could not be started: {detail}",
  "component.terminal.phaseDisconnected": "The engine disconnected and ended this shell",
  "component.terminal.action.reopen": "Reopen",
  "component.terminal.action.stop": "Stop",
  "component.terminal.action.clear": "Clear",
  "component.terminal.action.clearAll": "Clear scrollback",
  "component.terminal.action.clearAllHint": "Also removes the lines above the viewport",
  "component.terminal.action.fontSmaller": "Smaller terminal text",
  "component.terminal.action.fontLarger": "Larger terminal text",
  "component.terminal.action.more": "More actions",
  "component.terminal.menu.copy": "Copy",
  "component.terminal.menu.paste": "Paste",
  "component.terminal.menu.selectAll": "Select all",
  "component.terminal.menu.search": "Search",
  "component.terminal.menu.export": "Export",
  "component.terminal.menu.openExternal": "Open this folder in the system terminal",
  "component.terminal.paste.confirmTitle": "Paste {lines} lines?",
  "component.terminal.paste.confirmMessage":
    "The shell will run each of the {lines} lines as it receives them.",
  "component.terminal.a11y.region": "Terminal",

  // The search bar. `matchCount` is a plural because English says "1 match" and
  // "3 matches"; Chinese selects only `other`, so its single branch carries the
  // same two placeholders and the placeholder check keeps the pair honest.
  // `prevMatch`/`nextMatch` are the two arrows' accessible names, not their
  // tooltips: a control nobody can identify by ear is a control half the users
  // cannot operate.
  "component.terminal.search.placeholder": "Find in scrollback",
  "component.terminal.search.noMatch": "No matches",
  "component.terminal.search.prevMatch": "Previous match",
  "component.terminal.search.nextMatch": "Next match",
  "component.terminal.search.matchCount":
    "Match {index} of {count, plural, one {# match} other {# matches}}",
  // The addon stops collecting at its highlight limit, so a count that reached it
  // is a lower bound, not a number. It gets its own sentence instead of a "+"
  // glued onto the one above: the branch is "this number could be wrong", and a
  // user who disproves a plain count stops trusting the counts that were exact.
  "component.terminal.search.matchCountAtLeast":
    "Match {index} of at least {count, plural, one {# match} other {# matches}}",

  // ------------------------------------------------------------------ page
  "page.conversation.empty.title": "No conversation yet",
  "page.conversation.empty.description": "Start typing to begin",
  "page.conversation.retryLater": "Try again in a moment",
  "page.nav.title": "Navigation",
  "page.conversation.title": "Conversation",
  "page.tree.title": "Files",
  "page.terminal.title": "Terminal",
  "page.terminal.unavailable":
    "The terminal is unavailable because the shell bridge is not connected.",
  "page.error.retry": "Try again",
  "page.commandSample.title": "Command sample",
  "page.commandSample.deviceInfo": "Get device info",
  "page.commandSample.terminalKill": "Kill sample terminal",
  "page.commandSample.answered": "Answered",
  "page.commandSample.accepted": "Sent to the engine",
  "page.commandSample.notAvailable": "This feature is not available",
  "page.commandSample.notConnected": "The engine is not connected",
  "page.commandSample.scopeRequired": "Select a conversation first",
  "page.commandSample.badPayload": "The request is invalid",
  "page.frame.empty.title": "No pages open",
  "page.frame.empty.open": "Open page",
  "page.frame.unknown.title": "Unknown page ({id})",
  "page.frame.unknown.description":
    "This page was created by a newer version and cannot be shown. Closing it only hides it; its layout data is kept.",
  "page.frame.error.title": "This page stopped working",
  "page.frame.tab.close": "Close tab",
  "page.frame.tab.closeOthers": "Close others",
  "page.frame.tab.closeAll": "Close all",
  "page.frame.picker.title": "Open a page",
  "page.frame.picker.main": "Main area",
  "page.frame.picker.side": "Side rail",

  "page.topbar.edit": "Edit",
  "page.topbar.help": "Help",
  "page.topbar.diagnostics": "Export diagnostics",
  "page.topbar.settings": "Settings",
  "page.topbar.updates": "Check for updates",
  "page.topbar.undo": "Undo",
  "page.topbar.redo": "Redo",
  "page.topbar.cut": "Cut",
  "page.topbar.copy": "Copy",
  "page.topbar.paste": "Paste",
  "page.topbar.selectAll": "Select all",
  "page.topbar.resetLayout": "Reset layout",
  "page.topbar.about": "About",
  "page.topbar.aboutTitle": "About Haruyuki",
  "page.topbar.version": "Version {version}",

  "page.frame.sideRail.title": "Side rail",
  "page.frame.sideRail.left": "Left rail",
  "page.frame.sideRail.right": "Right rail",
  "page.frame.sideRail.collapse": "Collapse side rail",
  "page.frame.sideRail.expand": "Expand side rail",
  "page.frame.sideRail.empty": "No pages on this side yet.",
  "page.frame.sideRail.swap": "Swap side rails",
  "page.frame.compact.back": "Back to the layout",
  "page.frame.banner.hidden":
    "{count} tabs are hidden and will reappear once their pages are available.",
  "page.frame.unknown.hide": "Close (hide only)",

  "page.topbar.resetTitle": "Reset layout?",
  "page.topbar.resetBody":
    "All pages return to the default arrangement. Unknown and hidden pages are kept.",
  "page.topbar.resetConfirm": "Reset",
  "page.topbar.cancel": "Cancel",

  "page.frame.banner.readFailed": "The layout could not be read; the default layout is in use.",
  "page.frame.banner.corrupt": "The layout could not be restored; the default layout is in use.",
  "page.frame.banner.readOnly":
    "This layout came from a newer version; it is read-only here and will not be overwritten until you upgrade.",

  "page.frame.badge.approvals": "{count} approvals waiting",
  "page.frame.badge.streaming": "Streaming",
  "page.frame.badge.unread": "{count} unread",

  // ----------------------------------------------------------------- error
  "error.network.unreachable": "The service is unreachable",
  "error.unexpected": "An unexpected error occurred",
  "error.withCode": "An error occurred ({code})",
  "error.shell.resourceDenied": "The application could not load a file it is not allowed to read",
  "error.shell.resourceMissing": "The application could not find a file it needs",
  "error.shell.bridgeDenied": "The application asked for a capability it does not have",
  "error.shell.settingsCorrupt": "Your settings could not be read, so defaults are in use",
  "error.shell.engineUnavailable": "The engine did not start",
  "error.shell.engineCrashed": "The engine stopped unexpectedly",
  "error.shell.diagnosticExportFailed": "The diagnostic bundle could not be exported",
  "error.shell.staleEngineFound": "An engine process from an earlier run is still running",
  "error.shell.staleEngineCleanFailed": "The leftover engine process could not be ended",
  "error.shell.unsupportedType": "This kind of file cannot be previewed",
  "error.runtimeMissing": "The bundled engine is missing",
  "error.runtimeMismatch": "The engine failed its integrity check",
  "error.runtimeSpawn": "The engine did not start",
  "error.runtimeExternal": "The external engine is unavailable",
  "error.runtimeExternalFallback": "The external engine is unavailable; using the bundled engine",
  "error.runtimeChoose": "Choose engine folder",
  "error.runtimeUseBundled": "Use bundled engine",
  "error.runtimeOpenLog": "Open logs",
  "error.runtimePath": "Engine path",
  "error.runtimeExpected": "Expected sha256",
  "error.runtimeActual": "Actual sha256",
  "error.runtimeLogPath": "Log directory",

  // -------------------------------------------------------------- reconnect
  // Wording states only what is known: a connection is being re-established, a
  // number of approvals stopped being answerable, older messages exist. Nothing
  // here promises when, because a reconnect can fail for longer than any sentence
  // could honestly cover.
  "component.reconnect.reconnecting": "Reconnecting",
  "component.reconnect.staleApprovals":
    "{count, plural, =0 {No approvals expired while offline} one {1 approval expired while offline} other {# approvals expired while offline}}",
  "component.reconnect.olderAvailable": "Older messages available",

  // ------------------------------------------------------------------ a11y
  "a11y.action.delete": "Delete",
  // -------------------------------------------------------- command surface
  "page.command.agentCreate.label": "Create agent",
  "page.command.agentCreate.desc": "Create an agent from a request body",
  "page.command.agentCreatePreset.label": "Create preset agent",
  "page.command.agentCreatePreset.desc": "Create an agent from a built-in personality preset",
  "page.command.agentDelete.label": "Delete agent",
  "page.command.agentDelete.desc": "Delete one agent by id",
  "page.command.agentGet.label": "Get agent",
  "page.command.agentGet.desc": "Read one agent by id",
  "page.command.agentList.label": "List agents",
  "page.command.agentList.desc": "List agents visible to this device",
  "page.command.agentSecretApply.label": "Apply secrets",
  "page.command.agentSecretApply.desc": "Apply a batch of secret mutations atomically",
  "page.command.agentSecretList.label": "List secrets",
  "page.command.agentSecretList.desc": "List the secret names and values for one agent",
  "page.command.agentUpdate.label": "Update agent",
  "page.command.agentUpdate.desc": "Update one agent's settings",
  "page.command.compactionCancel.label": "Cancel compaction",
  "page.command.compactionCancel.desc": "Drop a prepared compaction",
  "page.command.compactionCommit.label": "Commit compaction",
  "page.command.compactionCommit.desc": "Apply the chosen cut of a prepared compaction",
  "page.command.compactionPrepare.label": "Prepare compaction",
  "page.command.compactionPrepare.desc": "Build a compaction preview and a handle",
  "page.command.conversationCreate.label": "Create conversation",
  "page.command.conversationCreate.desc": "Create a conversation for an agent",
  "page.command.conversationDelete.label": "Delete conversation",
  "page.command.conversationDelete.desc": "Delete one conversation",
  "page.command.conversationFork.label": "Fork conversation",
  "page.command.conversationFork.desc": "Fork a conversation from a cut point",
  "page.command.conversationGet.label": "Get conversation",
  "page.command.conversationGet.desc": "Read one conversation by id",
  "page.command.conversationList.label": "List conversations",
  "page.command.conversationList.desc": "List conversations, optionally including hidden ones",
  "page.command.conversationRecompile.label": "Recompile conversation",
  "page.command.conversationRecompile.desc": "Recompile a conversation's context",
  "page.command.conversationSwitch.label": "Switch conversation",
  "page.command.conversationSwitch.desc": "Start or attach the runtime for a conversation",
  "page.command.conversationSync.label": "Sync conversation",
  "page.command.conversationSync.desc": "Ask the engine to resend the conversation state",
  "page.command.conversationUpdate.label": "Update conversation",
  "page.command.conversationUpdate.desc": "Update one conversation's metadata",
  "page.command.deviceInfo.label": "Device info",
  "page.command.deviceInfo.desc": "Read the engine version and capability flags",
  "page.command.deviceSetState.label": "Set device state",
  "page.command.deviceSetState.desc": "Set the permission mode, cwd or target conversation",
  "page.command.fileEdit.label": "Edit file",
  "page.command.fileEdit.desc": "Apply a text replacement to a file",
  "page.command.fileRead.label": "Read file",
  "page.command.fileRead.desc": "Read a file's bytes as text or base64",
  "page.command.fileUnwatch.label": "Unwatch file",
  "page.command.fileUnwatch.desc": "Stop watching a file",
  "page.command.fileWatch.label": "Watch file",
  "page.command.fileWatch.desc": "Start watching a file for changes",
  "page.command.fileWrite.label": "Write file",
  "page.command.fileWrite.desc": "Write a file's full content",
  "page.command.gitCheckoutBranch.label": "Checkout branch",
  "page.command.gitCheckoutBranch.desc": "Check out a git branch, optionally creating it",
  "page.command.gitSearchBranches.label": "Search branches",
  "page.command.gitSearchBranches.desc": "Search branch names by substring",
  "page.command.memoryCommitDiff.label": "Memory commit diff",
  "page.command.memoryCommitDiff.desc": "Read the diff of one memory commit",
  "page.command.memoryDeleteFile.label": "Delete memory file",
  "page.command.memoryDeleteFile.desc": "Delete one file from agent memory",
  "page.command.memoryEnable.label": "Enable memory",
  "page.command.memoryEnable.desc": "Enable the git-backed memory tree for an agent",
  "page.command.memoryFileAtRef.label": "Memory file at ref",
  "page.command.memoryFileAtRef.desc": "Read a memory file as of a ref",
  "page.command.memoryHistory.label": "Memory history",
  "page.command.memoryHistory.desc": "List commits touching a memory file",
  "page.command.memoryList.label": "List memory files",
  "page.command.memoryList.desc": "List the files in an agent's memory",
  "page.command.memoryReadFile.label": "Read memory file",
  "page.command.memoryReadFile.desc": "Read one memory file",
  "page.command.memoryWriteFile.label": "Write memory file",
  "page.command.memoryWriteFile.desc": "Write one memory file with an optional commit message",
  "page.command.messageAbort.label": "Abort turn",
  "page.command.messageAbort.desc": "Interrupt the active turn or pending approval",
  "page.command.messageList.label": "List messages",
  "page.command.messageList.desc": "Page through a conversation's messages",
  "page.command.messageSend.label": "Send message",
  "page.command.messageSend.desc": "Send messages or answer an approval request",
  "page.command.modelList.label": "List models",
  "page.command.modelList.desc": "List the models this account may use",
  "page.command.modelUpdate.label": "Update model",
  "page.command.modelUpdate.desc": "Switch the model or its reasoning effort",
  "page.command.providerConnect.label": "Connect provider",
  "page.command.providerConnect.desc": "Store credentials for a model provider",
  "page.command.providerDisconnect.label": "Disconnect provider",
  "page.command.providerDisconnect.desc": "Remove a provider's credentials",
  "page.command.providerListConnected.label": "List providers",
  "page.command.providerListConnected.desc": "List the provider store's configured rows",
  "page.command.queueRemove.label": "Remove queued message",
  "page.command.queueRemove.desc": "Remove one queued message",
  "page.command.queueResume.label": "Resume queue",
  "page.command.queueResume.desc": "Release the queue items waiting on an interruption",
  "page.command.queueStopMonitor.label": "Stop monitor",
  "page.command.queueStopMonitor.desc": "Stop a background monitor process",
  "page.command.settingsGetExperiments.label": "Get experiments",
  "page.command.settingsGetExperiments.desc": "Read the experiment flags",
  "page.command.settingsGetReflection.label": "Get reflection",
  "page.command.settingsGetReflection.desc": "Read the reflection switches",
  "page.command.settingsSetExperiment.label": "Set experiment",
  "page.command.settingsSetExperiment.desc": "Turn one experiment on or off",
  "page.command.settingsSetReflection.label": "Set reflection",
  "page.command.settingsSetReflection.desc": "Update the reflection switches",
  "page.command.slashExec.label": "Run command",
  "page.command.slashExec.desc": "Run one engine command and return its text",
  "page.command.subagentLaunch.label": "Launch subagent",
  "page.command.subagentLaunch.desc": "Launch a subagent with an initial task",
  "page.command.terminalInput.label": "Terminal input",
  "page.command.terminalInput.desc": "Send input bytes to a terminal",
  "page.command.terminalKill.label": "Kill terminal",
  "page.command.terminalKill.desc": "Terminate a terminal",
  "page.command.terminalResize.label": "Resize terminal",
  "page.command.terminalResize.desc": "Resize a terminal",
  "page.command.terminalSpawn.label": "Spawn terminal",
  "page.command.terminalSpawn.desc": "Open a new terminal",
  "page.command.toolsetUpdate.label": "Update toolset",
  "page.command.toolsetUpdate.desc": "Switch the harness toolset preset",
  "page.command.usageAggregate.label": "Usage totals",
  "page.command.usageAggregate.desc": "Aggregate usage ledger rows",
  "page.command.usageChatgpt.label": "ChatGPT usage",
  "page.command.usageChatgpt.desc": "Read the ChatGPT subscription windows",
  "page.command.workspaceCwdMap.label": "Working directories",
  "page.command.workspaceCwdMap.desc": "Read per-conversation working directories",
  "page.command.workspaceGrep.label": "Search in files",
  "page.command.workspaceGrep.desc": "Grep across the workspace",
  "page.command.workspaceList.label": "List directory",
  "page.command.workspaceList.desc": "List one directory",
  "page.command.workspaceSearch.label": "Find files",
  "page.command.workspaceSearch.desc": "Find files by path substring",
  "page.command.workspaceSetBootCwd.label": "Set boot directory",
  "page.command.workspaceSetBootCwd.desc": "Set the listener's boot working directory",
  "page.command.workspaceTree.label": "Show tree",
  "page.command.workspaceTree.desc": "Show a directory tree to a depth",
  "page.command.agent.name": "Agents",
  "page.command.compaction.name": "Compaction",
  "page.command.conversation.name": "Conversations",
  "page.command.device.name": "Device",
  "page.command.file.name": "Files",
  "page.command.git.name": "Git",
  "page.command.memory.name": "Memory",
  "page.command.message.name": "Messages",
  "page.command.model.name": "Models",
  "page.command.provider.name": "Providers",
  "page.command.queue.name": "Queue",
  "page.command.settings.name": "Settings",
  "page.command.slash.name": "Commands",
  "page.command.subagent.name": "Subagents",
  "page.command.terminal.name": "Terminal",
  "page.command.toolset.name": "Toolset",
  "page.command.usage.name": "Usage",
  "page.command.workspace.name": "Workspace",
} as const satisfies LocaleMessages;

/** The key union every `t()` call is checked against. */
export type MessageKey = keyof typeof en;
