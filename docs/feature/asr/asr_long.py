"""Realistic-length probe: upload long.wav via temp storage, transcribe with both filetrans models,
save result JSONs, and time each phase. Also: sync qwen3-asr-flash with base64 of the same file."""
import json, os, sys, time, base64
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from asr_probe import HERE, get_policy, oss_upload, async_submit, poll, call, BASE, redact, sync_asr

PATH = os.path.join(HERE, "long.wav")


def fetch_json(url):
    import urllib.request
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def run(model, params, tag):
    t0 = time.time()
    st, txt, dt, _ = get_policy(model)
    assert st == 200, txt
    pol = json.loads(txt)["data"]
    st, txt, dt, oss = oss_upload(pol, PATH)
    print(f"[{tag}] upload {os.path.getsize(PATH)} bytes -> HTTP {st} in {dt:.2f}s")
    assert st == 200, txt
    inp = {"file_urls": [oss]} if model.startswith("qwen-audio") else {"file_url": oss}
    st, txt, dt, _ = async_submit(model, inp, {"X-DashScope-OssResourceResolve": "enable"}, params=params)
    print(f"[{tag}] submit -> HTTP {st} in {dt:.2f}s: {redact(txt[:300])}")
    if st != 200:
        return
    tid = json.loads(txt)["output"]["task_id"]
    j = poll(tid, 300)
    print(f"[{tag}] total wall {time.time()-t0:.1f}s; poll response:")
    print(redact(json.dumps(j, ensure_ascii=False)[:900]))
    out = j.get("output", {})
    url = out.get("result", {}).get("transcription_url") if isinstance(out.get("result"), dict) else None
    if not url and isinstance(out.get("output"), dict):
        url = out["output"].get("transcription_url")
    if not url:
        print("no transcription_url")
        return
    res = fetch_json(url)
    fn = os.path.join(HERE, f"result-{tag}.json")
    open(fn, "w", encoding="utf-8").write(res)
    r = json.loads(res)
    tr = r["transcripts"][0]
    print(f"[{tag}] result saved {fn}; {len(res)} bytes; sentences={len(tr.get('sentences', []))}")
    print("  text:", tr["text"][:400])
    for s in tr.get("sentences", [])[:4]:
        print("  ", {k: v for k, v in s.items() if k != "words"})
    print("  first words:", s.get("words", [])[:3] if tr.get("sentences") else None)
    print("  usage:", j.get("usage"))


if __name__ == "__main__":
    which = sys.argv[1:] or ["q3", "qa", "qa-diar", "sync"]
    if "q3" in which:
        run("qwen3-asr-flash-filetrans", {"channel_id": [0], "enable_itn": True, "enable_words": True, "language": "zh"}, "q3")
    if "qa" in which:
        run("qwen-audio-3.0-asr-flash-filetrans", {"channel_id": [0], "language_hints": ["zh"]}, "qa")
    if "qa-diar" in which:
        run("qwen-audio-3.0-asr-flash-filetrans", {"channel_id": [0], "diarization_enabled": True, "speaker_count": 2,
             "context": [{"role": "user", "content": [{"type": "input_text", "text": "林小满、陈伯、旧书店"}]}]}, "qa-diar")
    if "sync" in which:
        b64 = base64.b64encode(open(PATH, "rb").read()).decode()
        st, txt, dt, _ = sync_asr("qwen3-asr-flash", f"data:audio/wav;base64,{b64}")
        print(f"[sync] base64 {len(b64)} chars -> HTTP {st} in {dt:.2f}s")
        print(redact(txt[:700]))
