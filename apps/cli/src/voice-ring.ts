/**
 * What the status ring should show for what the speech pipeline just did.
 *
 * The ring's rule (adapter-linux/src/leds.ts) is that anything moving means work is happening and a
 * still ring means nothing is. The pipeline's log events are the places work starts and stops, so this
 * is the whole mapping — kept apart so it is tested without a ring and shared by every command that
 * runs the pipeline.
 */
import type { LogEvent } from "@hearthkit/edge-voice";
import type { RingState } from "@hearthkit/adapter-linux";

export function ringForPipelineEvent(e: LogEvent): RingState | undefined {
  switch (e.event) {
    case "pipeline_loading": return "loading";          // the model is being read into memory
    case "pipeline_started": return "listening";        // loaded: ready, and still
    case "wake": return "hearing";                      // the wake word was heard: whoever said it is about to say the rest
    case "speech_started": return "hearing";            // someone is talking
    case "speech_ended": return "recognizing";          // they stopped; the words are being worked out
    case "stt_empty": return "listening";               // nothing there after all: back to rest
    case "stt_error": return "failed";                  // one utterance could not be recognised: an answer, held, then rest
    case "pipeline_stopped": return undefined;          // whoever stopped it decides what the ring shows
    default: return undefined;                          // a final transcript hands over to the agent (thinking)
  }
}
