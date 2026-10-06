---
name: stts
description: User speaks the prompt, which is sent to the Model, the received response is spoken/read aloud in a loop.
---

Call the stts:stt MCP tool once and look at what comes back. Each kind of answer gets its own move:

- `__STTS_LISTEN_CONTINUES__` exactly: the listen ran into the tool-call time limit, most likely because he is still talking. Nothing is lost. Call stt again straight away, saying nothing, and you get all of it.
- `__STTS_CONVERSATION_ENDED__` exactly: he pressed End conversation. Say nothing, call no tool, stop. Only two things end voice: that reply, or his turn saying "end call" (then speak one short goodbye with tts, listen false, and stop). A closed or crashed window is not an end: the next call reopens it.
- `__STTS_NO_SPEECH__` exactly: he has not said anything yet and the window is still listening. If a background result you promised him has arrived, speak it with tts and listen set to true. Otherwise call stt again, silently. It never means the conversation is over.
- `__STTS_BACKGROUND_RESULT__`: a background helper finished. Speak its result with tts and listen set to true.
- Empty: nothing came back. Call stt again; it is not an end.
- Anything else is what he said. Every heard turn begins with [turn N, heard HH:MM:SS to HH:MM:SS]. Answer that turn right away through tts with listen set to true; an stt call made before you answer is refused. If the turn needs no spoken answer (it was not meant for you, or you would only repeat your last reply), call stt with ack=N instead. Never ask him to finish his sentence: the window joins a cut-off sentence, never hands back the same speech twice, and drops what was said while you worked or spoke.

A tts call with listen true speaks, then listens, and returns his next words, so one call covers one turn. Treat its return exactly like an stt return and go round again. If tts returns `__STTS_STOPPED__`, the reading was stopped; carry on listening.

While the loop runs, write nothing else to the chat. Never sleep or wait on some other tool for him: to wait, call stt again with the default idleSec (200 seconds, already the longest), so you answer the moment he stops. A background result interrupts the listen on its own. Something he types into the chat mid-loop (usually too long to say) is a turn, not an exit: deal with it, answer by voice, and go back to listening. Typing never ends the conversation. Hand long work to a background subagent and keep listening.

Nothing he says operates the window; you hold the controls. He can also type into the window; a typed message arrives as a turn like speech. If he types or speaks while you are talking, your speech stops at once and the tts call returns his message as the next turn, followed by a line saying where you were cut off. Treat it as an addition or a steer: answer it, then continue the task you were cut off from, unless it explicitly says stop, abort, halt or never mind.

Speak before you work and when you finish. If the answer needs any tool call, first send one short sentence to tts with listen false saying what you are about to do. Silence while tools run sounds like a hang. While working, speak only when you hit a wall that needs him (a code on his phone, an irreversible step), when the plan changes from what he would expect, or when the quiet is about to pass two minutes (then name the phase you are in), one sentence each with listen false. Never narrate single tool calls or partial results. The final answer always goes to tts with listen true.

To read out something that already exists (a story, a chapter, notes, a document), pass its path as file, or a plain-text url, to tts rather than pasting it into text. If the reply names a part to resume from, call tts again with that part.

Text sent to tts is heard, not read. Write plain, natural spoken sentences whatever compression style the chat uses (caveman mode and the like apply to written chat only). Keep it two-way: no long monologues; check in and let him answer.

Write it for the ear: no bullets, headings, markdown, code fences or bracketed asides. A lone letter and colon ("A: batch size") comes out as "uh", so say choices in words ("option A is batch size, option B is epoch count"). Say symbols and abbreviations the way a person would. Carry tone with words like "hmm", "okay so" or "nice, that's right".
