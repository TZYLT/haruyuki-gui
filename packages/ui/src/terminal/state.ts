/**
 * The terminal panel's six-phase state machine, as one pure function.
 *
 * The panel renders what this state says and nothing it does not: one phase plus
 * six facts about the session behind it. Why a function rather than conditions
 * spread through the component: most of the decision table is arrivals that must
 * change nothing (a duplicate readiness frame, a late exit for a session already
 * reported, a second spawn answer). A forgotten `if` in a component fails
 * silently -- the panel starts showing something it invented -- while a forgotten
 * branch here fails a test.
 *
 * Why a no-op returns the input object itself
 *   "Ignored" is then an observable property, not a comment. The panel feeds this
 *   into React state, and React skips the re-render only when the next value is
 *   the same object; a freshly allocated but equal object would repaint on every
 *   duplicate frame. The tests therefore assert identity (`toBe`), not equality.
 *
 * Which fields this function owns
 *   `phase`, `pid`, `exitCode` and `failureDetail` describe one session and are
 *   written here. `terminalId`, `cwd`, `fontSize` and `searchVisible` come from
 *   the caller and are only copied through: no signal carries them (the terminal
 *   id is allocated once per panel and every reopen reuses it, `cwd` is the
 *   directory the caller chose for the spawn, the other two are view settings).
 *   An input whose fields contradict its phase is not something this function
 *   produced, so the reducer does not defend against it.
 *
 * What the state deliberately cannot say
 *   Engine readiness is not recorded. It is an input to the decision (whether a
 *   spawn may be sent) but not a fact about the session, and the frozen shape has
 *   no field for it: readiness is consumed by turning a live session into
 *   `disconnected`, and re-armable by turning `disconnected` back into `idle`.
 *   The panel additionally knows readiness from the shell, which is what gates the
 *   reopen button while the phase is still `exited` or `failed`.
 *
 * Two judgement calls, both stated where they happen below:
 *   - the 2 s coalescing window is expressed by refusal, not by a stored timer;
 *   - a spawn failure is recognised by the presence of `error`, not by its text.
 */

/**
 * The panel's visible situation. Copy belongs to the message catalogue, not here.
 *
 * Adding a phase breaks the build, measured by adding a throwaway seventh member
 * and running `tsc`: six errors, four of them in *this* file (the phase functions
 * below switch without a `default`) and two in `toolbar.tsx` (the availability
 * table and the copy switch). So the person adding a phase is told in their own
 * file first, and has to answer "may reopen, stop and clear be pressed in it?"
 * before it can exist. That is the design, not a defect to be silenced with a
 * `default`.
 *
 * `state.test.ts` stays green through that change (55/55), because its `PHASES`
 * list only drives loops: it would not notice the new member until somebody added
 * it there too. The compile errors are what cover that gap, and they arrive
 * before a test would.
 */
export type TerminalPhase =
  | "idle" // nothing running: the engine is not ready, or the panel has not mounted yet
  | "starting" // the spawn request is out, `terminal_spawned` has not arrived
  | "running" // the PTY is live and accepts input
  | "exited" // the shell ended normally, with an exit code
  | "failed" // the spawn itself failed; the engine's own text is kept verbatim
  | "disconnected"; // the engine is no longer ready; the engine killed the PTY

/** Everything the panel can observe about its terminal, with no free text. */
export interface TerminalPanelState {
  readonly phase: TerminalPhase;
  readonly terminalId: string | null; // null until the caller has allocated one
  readonly pid: number | null; // only from `terminal_spawned` on
  readonly exitCode: number | null; // only in `exited`
  readonly failureDetail: string | null; // only in `failed`; the engine's own text, untranslated
  readonly cwd: string | null; // the spawn directory; null means the engine's own start directory
  readonly fontSize: number;
  readonly searchVisible: boolean;
}

/** What the panel can be told. Engine frames, the engine's readiness, and the timer. */
export type TerminalSignal =
  | { readonly kind: "spawn-requested" }
  | { readonly kind: "spawned"; readonly pid: number }
  | { readonly kind: "exited"; readonly exitCode: number; readonly error: string | null }
  | { readonly kind: "engine"; readonly ready: boolean }
  | { readonly kind: "reopen-allowed" }
  /**
   * A command the engine was asked to carry and refused, in its own words.
   *
   * Only `engine-rejected` reaches this signal. The command layer has three
   * failures and the other two are not this one: an unavailable channel and a
   * missing capability never reached the engine, so they are reported beside the
   * phase rather than in it -- see the panel's notice line. Sending them here
   * would print "the shell could not be started" for a build that simply cannot
   * start one yet, and sent the user looking for a fault that is not there.
   *
   * It exists because the phase machine otherwise learns about failure only from
   * a pushed frame. A spawn the engine refuses is answered on the request itself,
   * so without this signal the panel would sit in `starting` waiting for a frame
   * that will never arrive.
   */
  | { readonly kind: "rejected"; readonly detail: string }
  /**
   * The spawn request never reached the command layer, so the start it announced
   * is cancelled and the panel returns to `idle`.
   *
   * Distinct from {@link TerminalSignal.rejected} on purpose: that one says the
   * engine answered and refused, this one says the engine was never asked.
   */
  | { readonly kind: "start-withdrawn" };

/**
 * The next state for one signal.
 *
 * @param state the current state
 * @param signal what happened
 * @returns the next state; the same object when the signal changes nothing
 */
export function reducePhase(state: TerminalPanelState, signal: TerminalSignal): TerminalPanelState {
  switch (signal.kind) {
    case "spawn-requested":
      return requestStart(state);

    case "spawned":
      return confirmStart(state, signal.pid);

    case "exited":
      return settleSession(state, signal.exitCode, signal.error);

    case "engine":
      return applyReadiness(state, signal.ready);

    case "rejected":
      return rejectCommand(state, signal.detail);

    case "start-withdrawn":
      return withdrawStart(state);

    case "reopen-allowed":
      // Accepted, and intentionally inert. The window it reports is engine-side:
      // a second spawn for a session that is still inside it is coalesced by the
      // engine, which re-answers with the pid it already has. The panel therefore
      // needs no timer of its own to survive a duplicate request -- the refusal in
      // `requestStart` plus the acceptance in `confirmStart` already make the
      // request idempotent, and that answer is indistinguishable from a first
      // one. The same window also covers the kill that a remount sends, so this
      // signal must not be read as "a session died": it says nothing about the
      // session, only that the coalescing window has closed.
      return state;
  }
}

/**
 * The spawn request was never handed over, so the start it announced is cancelled.
 *
 * The phase moved to `starting` before the command was sent, deliberately: a second
 * click must find the panel already in flight. That optimism has to be undone when
 * the command layer answers that it could not carry the request -- otherwise the
 * panel stays in `starting` forever, waiting for a frame that has no reason to
 * come. Nothing else is touched, because nothing else happened.
 *
 * @param state the current state
 * @returns the idle state, or `state` when no start was in flight
 */
function withdrawStart(state: TerminalPanelState): TerminalPanelState {
  switch (state.phase) {
    case "starting":
      return { ...state, phase: "idle", pid: null, exitCode: null, failureDetail: null };

    case "idle":
    case "running":
    case "exited":
    case "failed":
    case "disconnected":
      // Either no request was in flight (so there is nothing to withdraw), or the
      // session already moved on and the request it answers is no longer the one
      // this state describes.
      return state;
  }
}

/**
 * A command the engine refused, after it was handed over.
 *
 * Distinct from {@link settleSession}'s failure arm, which reads a pushed frame:
 * this one answers a request, so it can arrive in any phase that could have sent
 * it. `exited` and `failed` accept it because reopening a finished session is
 * offered exactly there.
 *
 * @param state the current state
 * @param detail the engine's own text, about to be shown verbatim
 * @returns the failed state, or `state` when there was no session to fail
 */
function rejectCommand(state: TerminalPanelState, detail: string): TerminalPanelState {
  switch (state.phase) {
    case "idle":
    case "starting":
    case "running":
    case "exited":
    case "failed":
      // The pid and exit code are dropped for the same reason as in
      // `requestStart`: neither describes the attempt that just failed, and
      // carrying the previous session's code into a failure banner would report a
      // result the panel no longer has.
      return { ...state, phase: "failed", pid: null, exitCode: null, failureDetail: detail };

    case "disconnected":
      // Nothing could have been handed over: the request path is closed while the
      // engine is away. Keeping the phase is the honest answer, because "the
      // engine refused this" is a claim about a conversation that did not happen.
      return state;
  }
}

/**
 * A start was requested: the first session, or the reopen of a finished one.
 *
 * @param state the current state
 * @returns the starting state, or `state` when the request must not act
 */
function requestStart(state: TerminalPanelState): TerminalPanelState {
  switch (state.phase) {
    case "idle":
    case "exited":
    case "failed":
      // The two ends of one flow. From idle this is the first session; from
      // exited or failed it is the reopen the panel offers, and it reuses the
      // same terminal id because the engine keys sessions by that id.
      //
      // Every outcome of the previous attempt is cleared: a panel that says
      // "terminated with code 0" while a spawn is in flight reports a result it
      // no longer has, and the same goes for a stale failure text.
      return {
        ...state,
        phase: "starting",
        pid: null,
        exitCode: null,
        failureDetail: null,
      };

    case "starting":
    case "running":
      // A session is already being started or is live. Accepting this would put
      // two spawn requests behind one panel: the engine coalesces the duplicate
      // and answers with the pid it already has, so the panel would later have to
      // guess which answer belonged to which request. This is also what makes the
      // engine's 2 s window harmless here rather than something to time.
      return state;

    case "disconnected":
      // The engine killed the PTY when the connection closed, so a request now
      // cannot be delivered. Staying here keeps the panel from showing a
      // "starting" it has no way to finish; the request becomes possible again
      // when readiness returns, because that moves the phase back to idle.
      return state;
  }
}

/**
 * `terminal_spawned` arrived: the session exists and has a pid.
 *
 * @param state the current state
 * @param pid the pid the engine reported; stored verbatim, never inferred
 * @returns the running state, or `state` when the answer must be ignored
 */
function confirmStart(state: TerminalPanelState, pid: number): TerminalPanelState {
  switch (state.phase) {
    case "starting":
      return { ...state, phase: "running", pid };

    case "idle":
      // No spawn was requested from this panel, so this answer belongs to a
      // session it never asked for. Adopting it would enter "running" for a
      // process whose ownership is unknown, and every input would then be routed
      // to it.
      return state;

    case "running":
      // A second answer for a live session. The pid identifies the process, and
      // overwriting the one already shown would silently swap the identity of a
      // session that has not changed; the duplicate is the engine's coalesced
      // reply to a request that was already satisfied.
      return state;

    case "exited":
    case "failed":
      // The end of this session was already reported, so this answer raced with
      // that end (a spawn that exits immediately, or a slow reconnect). Taking it
      // would show a live session backed by a process that is already gone.
      return state;

    case "disconnected":
      // The engine killed the PTY on disconnect. This frame, if it arrives at
      // all, is for a process that no longer exists; adopting it would claim the
      // connection came back, which is what the readiness signal decides.
      return state;
  }
}

/**
 * `terminal_exited` arrived. One frame, two meanings: a normal end carries an
 * exit code, a failed spawn carries the engine's error text.
 *
 * @param state the current state
 * @param exitCode the reported exit code
 * @param error the engine's text, or null when the shell ended normally
 * @returns the exited or failed state, or `state` when the frame must be ignored
 */
function settleSession(
  state: TerminalPanelState,
  exitCode: number,
  error: string | null,
): TerminalPanelState {
  switch (state.phase) {
    case "starting":
    case "running": {
      if (error === null) {
        // A normal end. The pid is dropped because the process it named is gone,
        // and the code is what the panel shows; keeping both would invite a
        // reader to treat the pid as a handle.
        return { ...state, phase: "exited", pid: null, exitCode, failureDetail: null };
      }

      // The spawn path's failure. The engine sends exit code 1 with this frame,
      // but that value is a marker for "this was not an exit", so it is dropped
      // rather than stored: keeping it would let the panel print "terminated with
      // code 1" for a shell that never started, and would make a real shell that
      // exits with 1 indistinguishable from a failed spawn.
      //
      // The split is on presence, not on text: the engine sets this field only
      // from its spawn catch branch, so whatever it sends -- including an empty
      // string -- is the failure branch. Reporting such a frame as a normal exit
      // would claim an end that did not happen.
      return { ...state, phase: "failed", pid: null, exitCode: null, failureDetail: error };
    }

    case "idle":
      // No session of ours is live, so this is either a frame for a session the
      // engine killed on disconnect, or a duplicate. Flipping to "exited" would
      // report a normal end for a connection that was lost.
      return state;

    case "exited":
      // Already reported. A second frame would overwrite the exit code of an end
      // that has happened, and a frame carrying an error would even move the
      // panel from exited to failed -- changing the story after the fact.
      return state;

    case "failed":
      // Same reasoning, in the other direction: a late normal-end frame must not
      // turn a failed spawn into a clean exit, which is exactly the distinction
      // the two phases exist for.
      return state;

    case "disconnected":
      // The engine killed the PTY when the connection closed. This phase already
      // says the session is over; turning it into "exited with code N" would
      // report a normal end for a kill, and would also re-enable the reopen while
      // the engine is still not ready.
      return state;
  }
}

/**
 * The engine's readiness changed.
 *
 * @param state the current state
 * @param ready whether the engine is ready now
 * @returns the disconnected or idle state, or `state` when nothing changes
 */
function applyReadiness(state: TerminalPanelState, ready: boolean): TerminalPanelState {
  if (!ready) {
    switch (state.phase) {
      case "starting":
      case "running":
        // The engine kills every PTY of a connection when it closes it, so a live
        // terminal is dead at this moment. `starting` counts as live for the same
        // reason: the request is out, the engine may already have created the
        // PTY, and no answer will now arrive. Without this the panel would wait
        // on "starting" forever after the engine went away.
        return {
          ...state,
          phase: "disconnected",
          pid: null,
          exitCode: null,
          failureDetail: null,
        };

      case "idle":
      case "exited":
      case "failed":
        // Nothing of ours is alive: the phase already describes a panel with no
        // engine behind it, and a repeated readiness drop (the shell polls it) is
        // not news. The reopen button is gated by the shell's own readiness,
        // which the panel reads directly; the phase does not repeat it.
        return state;

      case "disconnected":
        // Already reported. Repeating it must not churn the state, otherwise the
        // panel would repaint on every poll.
        return state;
    }
  }

  switch (state.phase) {
    case "disconnected":
      // Readiness is back, but the old terminal does not come back with it: the
      // engine killed the process, and there is nothing to reattach to. Landing
      // in idle (with the terminal id kept, since it is reused by a reopen) is
      // what makes the panel say "connection restored, reopen to start a new
      // session" instead of pretending the session survived.
      //
      // Nothing is started here on purpose. A spawn request must be the caller's
      // explicit decision, because it depends on a fact this state does not
      // carry: whether a start was wanted. The caller asks by sending the spawn
      // request, which is what moves the phase to "starting".
      return {
        ...state,
        phase: "idle",
        pid: null,
        exitCode: null,
        failureDetail: null,
      };

    case "idle":
      // Ready and nothing running. This is the state a freshly mounted panel is
      // in for one frame before it asks to start, and the state a panel returns
      // to after a disconnect. Readiness alone is not a session fact, so there is
      // nothing to change.
      return state;

    case "starting":
      // A readiness frame while a spawn is in flight does not confirm the spawn.
      // Treating it as a confirmation would enter "running" without ever having
      // received a pid.
      return state;

    case "running":
      // The session is already known to be live; a repeated readiness frame says
      // nothing new about it. Reacting would restart a working session.
      return state;

    case "exited":
    case "failed":
      // The session is over; readiness does not reopen it. The caller asks for a
      // new one with a spawn request.
      return state;
  }
}
