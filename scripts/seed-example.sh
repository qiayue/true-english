#!/usr/bin/env bash
# 灌入一个完整的实例：2 张卡片 + 1 次批改。
# 用来第一次打开就能看到整条链路长什么样，不需要先自己练。
set -euo pipefail
PORT="${PORT:-5173}"
B="http://localhost:$PORT"

T1="I used to think shipping fast was about typing fast. It's not. It's about having fewer things to decide."
T2="Most of my best decisions looked boring at the time."

python3 - "$B" "$T1" "$T2" <<'PY'
import json,sys,urllib.request as u
B,t1,t2=sys.argv[1],sys.argv[2],sys.argv[3]
def post(p,d):
    r=u.Request(B+p,data=json.dumps(d).encode(),headers={"content-type":"application/json"})
    return json.load(u.urlopen(r))
post("/api/cards/import",{"texts":[t1,t2],"json":open("data/seed/example-cards.json").read()})
cid=[c["id"] for c in json.load(u.urlopen(B+"/api/cards"))["cards"] if c["level"]==3][0]
att="Before I think do thing fast is typing fast. No. Is you need make less decision."
post("/api/reviews/import",{"cardId":cid,"attempt":att,"json":open("data/seed/example-review.json").read()})
print("已灌入实例：2 张卡片 + 1 次批改。打开", B, "看看。")
PY
