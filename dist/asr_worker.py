"""Speech worker (spec 014). argv: onnx-asr model name, model folder. stdin: uint32 LE byte count, then float32 16 kHz mono. stdout: one JSON line per request."""
import json
import struct
import sys

import numpy as np
import onnx_asr

m = onnx_asr.load_model(sys.argv[1], sys.argv[2], quantization="int8")


def hear(audio):
    # Parakeet TDT sometimes decodes clear speech to nothing; the same audio 0.1 s later decodes (NeMo issue 15757).
    text = m.recognize(audio, sample_rate=16000) if len(audio) > 1600 else ""
    return text or (m.recognize(audio[1600:], sample_rate=16000) if len(audio) > 4800 else "")


inp, out = sys.stdin.buffer, sys.stdout.buffer
while len(head := inp.read(4)) == 4:
    audio = np.frombuffer(inp.read(struct.unpack("<I", head)[0]), dtype="<f4")
    try:
        reply = {"text": hear(audio)}
    except Exception as e:
        reply = {"error": repr(e)}
    out.write(json.dumps(reply).encode() + b"\n")
    out.flush()
