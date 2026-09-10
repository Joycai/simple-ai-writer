"""Live probe of DashScope ASR: sync, async (two model ids), temp upload -> oss:// -> async.
Run from the scratchpad dir. Key from the DASHSCOPE_API_KEY env var, never printed.
"""
import json, os, sys, time, urllib.request, urllib.error, uuid, mimetypes

HERE = os.path.dirname(os.path.abspath(__file__))
KEY = os.environ["DASHSCOPE_API_KEY"]
BASE = "https://dashscope.aliyuncs.com"
SAMPLE_URL = "https://dashscope.oss-cn-beijing.aliyuncs.com/audios/welcome.mp3"
SAMPLE_PATH = os.path.join(HERE, "welcome.mp3")


def redact(s: str) -> str:
    return s.replace(KEY, "<KEY>")


def call(method, url, body=None, headers=None, raw=None, timeout=120):
    h = {"Authorization": f"Bearer {KEY}"}
    if headers:
        h.update(headers)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    if raw is not None:
        data = raw
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            txt = r.read().decode("utf-8", "replace")
            return r.status, txt, time.time() - t0, dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), time.time() - t0, dict(e.headers)


def show(label, status, txt, dt, hdrs=None, limit=1500):
    print(f"\n### {label}  -> HTTP {status}  ({dt:.2f}s)")
    if hdrs:
        keep = {k: v for k, v in hdrs.items() if k.lower() in ("x-request-id", "req-cost-time", "req-arrive-time", "content-type")}
        print("headers:", keep)
    print(redact(txt[:limit]))


def ensure_sample():
    if not os.path.exists(SAMPLE_PATH):
        urllib.request.urlretrieve(SAMPLE_URL, SAMPLE_PATH)
    print("sample bytes:", os.path.getsize(SAMPLE_PATH))


def sync_asr(model, audio):
    body = {
        "model": model,
        "input": {"messages": [
            {"role": "system", "content": [{"text": ""}]},
            {"role": "user", "content": [{"audio": audio}]},
        ]},
        "parameters": {"asr_options": {"enable_itn": False}},
    }
    return call("POST", f"{BASE}/api/v1/services/aigc/multimodal-generation/generation", body)


def async_submit(model, input_obj, extra_headers=None, params=None):
    body = {"model": model, "input": input_obj, "parameters": params or {"channel_id": [0], "enable_itn": False}}
    h = {"X-DashScope-Async": "enable"}
    if extra_headers:
        h.update(extra_headers)
    return call("POST", f"{BASE}/api/v1/services/audio/asr/transcription", body, h)


def poll(task_id, max_s=180):
    t0 = time.time()
    n = 0
    while time.time() - t0 < max_s:
        st, txt, dt, _ = call("GET", f"{BASE}/api/v1/tasks/{task_id}")
        n += 1
        try:
            j = json.loads(txt)
        except Exception:
            print("poll non-json:", redact(txt[:300]))
            return None
        status = j.get("output", {}).get("task_status")
        print(f"  poll#{n} +{time.time()-t0:.1f}s status={status}")
        if status in ("SUCCEEDED", "FAILED", "UNKNOWN") or st != 200:
            return j
        time.sleep(2)
    return None


def fetch_result(j):
    url = j.get("output", {}).get("result", {}).get("transcription_url")
    if not url:
        # some variants nest under results[]
        res = j.get("output", {}).get("results")
        if isinstance(res, list) and res:
            url = res[0].get("transcription_url")
    if not url:
        print("no transcription_url in:", json.dumps(j, ensure_ascii=False)[:800])
        return None
    with urllib.request.urlopen(url, timeout=60) as r:
        txt = r.read().decode("utf-8", "replace")
    print("result json bytes:", len(txt))
    print(txt[:1500])
    return txt


def get_policy(model):
    return call("GET", f"{BASE}/api/v1/uploads?action=getPolicy&model={model}", headers={"Content-Type": "application/json"})


def oss_upload(policy, path):
    name = os.path.basename(path)
    key = f"{policy['upload_dir']}/{name}"
    boundary = "----probe" + uuid.uuid4().hex
    fields = {
        "OSSAccessKeyId": policy["oss_access_key_id"],
        "Signature": policy["signature"],
        "policy": policy["policy"],
        "x-oss-object-acl": policy["x_oss_object_acl"],
        "x-oss-forbid-overwrite": policy["x_oss_forbid_overwrite"],
        "key": key,
        "success_action_status": "200",
    }
    parts = []
    for k, v in fields.items():
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
    ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: {ctype}\r\n\r\n".encode())
    parts.append(open(path, "rb").read())
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    body = b"".join(parts)
    req = urllib.request.Request(policy["upload_host"], data=body, method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.read().decode("utf-8", "replace"), time.time() - t0, f"oss://{key}"
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), time.time() - t0, f"oss://{key}"


def main(which):
    ensure_sample()
    if "sync" in which:
        st, txt, dt, h = sync_asr("qwen3-asr-flash", SAMPLE_URL)
        show("SYNC qwen3-asr-flash, public URL", st, txt, dt, h)
        # base64 data url path (what a local file would need without upload)
        import base64
        b64 = base64.b64encode(open(SAMPLE_PATH, "rb").read()).decode()
        st, txt, dt, h = sync_asr("qwen3-asr-flash", f"data:audio/mpeg;base64,{b64}")
        show("SYNC qwen3-asr-flash, base64 data URL", st, txt, dt, h)

    if "async" in which:
        for model, inp in [
            ("qwen3-asr-flash-filetrans", {"file_url": SAMPLE_URL}),
            ("qwen-audio-3.0-asr-flash-filetrans", {"file_urls": [SAMPLE_URL]}),
            ("qwen-audio-3.0-asr-flash-filetrans", {"file_url": SAMPLE_URL}),
        ]:
            st, txt, dt, h = async_submit(model, inp, params={"channel_id": [0], "enable_itn": False, "enable_words": True})
            show(f"ASYNC submit {model} input={list(inp)}", st, txt, dt, h)
            if st == 200:
                tid = json.loads(txt)["output"]["task_id"]
                j = poll(tid)
                if j:
                    print(redact(json.dumps(j, ensure_ascii=False)[:1200]))
                    if j["output"].get("task_status") == "SUCCEEDED":
                        fetch_result(j)

    if "upload" in which:
        for model in ["qwen3-asr-flash-filetrans", "qwen-audio-3.0-asr-flash-filetrans"]:
            st, txt, dt, h = get_policy(model)
            show(f"getPolicy model={model}", st, txt, dt, h, limit=900)
            if st != 200:
                continue
            pol = json.loads(txt)["data"]
            st, txt, dt, oss = oss_upload(pol, SAMPLE_PATH)
            print(f"\n### OSS upload -> HTTP {st} ({dt:.2f}s) url={oss}\n{txt[:300]}")
            if st != 200:
                continue
            inp = {"file_urls": [oss]} if model.startswith("qwen-audio") else {"file_url": oss}
            # with resolve header
            st, txt, dt, h = async_submit(model, inp, {"X-DashScope-OssResourceResolve": "enable"},
                                          params={"channel_id": [0], "enable_itn": False, "enable_words": True})
            show(f"ASYNC submit {model} with oss:// + resolve header", st, txt, dt, h)
            if st == 200:
                tid = json.loads(txt)["output"]["task_id"]
                j = poll(tid)
                if j:
                    print(redact(json.dumps(j, ensure_ascii=False)[:1200]))
                    if j["output"].get("task_status") == "SUCCEEDED":
                        fetch_result(j)
            # without the header, to learn the failure shape
            st, txt, dt, h = async_submit(model, inp, params={"channel_id": [0]})
            show(f"ASYNC submit {model} with oss:// WITHOUT header", st, txt, dt, h, limit=600)
            if st == 200:
                tid = json.loads(txt)["output"]["task_id"]
                j = poll(tid, 60)
                if j:
                    print(redact(json.dumps(j, ensure_ascii=False)[:600]))


if __name__ == "__main__":
    main(sys.argv[1:] or ["sync", "async", "upload"])
