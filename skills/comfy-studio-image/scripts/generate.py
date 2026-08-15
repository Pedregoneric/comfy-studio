#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import urllib.parse
import urllib.request

def main():
    parser = argparse.ArgumentParser(description="Generate media through Comfy Studio")
    parser.add_argument("idea")
    parser.add_argument("--model")
    parser.add_argument("--negative")
    parser.add_argument("--width", type=int)
    parser.add_argument("--height", type=int)
    parser.add_argument("--steps", type=int)
    parser.add_argument("--cfg", type=float)
    parser.add_argument("--seed", type=int)
    parser.add_argument("--body-type", choices=["model default","canon accurate","slim","athletic","curvy","muscular","plus-size"])
    parser.add_argument("--character-accuracy", choices=["strict canon","recognizable","creative interpretation"])
    parser.add_argument("--no-enhance", action="store_true")
    parser.add_argument("--output-dir", default=os.environ.get("COMFY_STUDIO_OUTPUT_DIR", "./outputs"))
    args = parser.parse_args()
    base = os.environ.get("COMFY_STUDIO_URL", "http://127.0.0.1:3030").rstrip("/")
    body = {k: v for k, v in vars(args).items() if v is not None and k not in {"output_dir", "no_enhance"}}
    body["enhance"] = not args.no_enhance
    request = urllib.request.Request(base + "/api/agent/generate", data=json.dumps(body).encode(), headers={"Content-Type":"application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=620) as response:
        result = json.load(response)
    media = result["outputs"][0]
    output_dir = Path(args.output_dir).expanduser().resolve(); output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / Path(media["filename"]).name
    with urllib.request.urlopen(media["url"], timeout=120) as response:
        target.write_bytes(response.read())
    print(json.dumps({"prompt_id":result["prompt_id"],"model":result["model"],"loras":result.get("loras",[]),"seed":result["seed"],"prompt":result["prompt"],"negative":result.get("negative"),"file":str(target)}, indent=2))
    print(f"MEDIA:{target}")

if __name__ == "__main__":
    main()
