---
layout: default
title: 골드팝콘 Open API
---
<!-- 생성 파일이다. 직접 고치지 말 것 — 원본은 spec/openapi.yaml 의 info.description, 갱신은 `npm run docs`. -->
# 골드팝콘 Open API

유저가 직접 발급한 API 키로 금·은을 거래하는 공개 API

| | |
|---|---|
| Base URL | `https://api.goldpopcon.com/api` |
| 인증 | 요청마다 JWT 서명 — [§3 인증](#3-인증--요청마다-jwt-서명) |
| 키 발급 | 골드팝콘 앱 · [App Store](https://apps.apple.com/kr/app/id6747214612) · [Google Play](https://play.google.com/store/apps/details?id=com.keumbang.goldpopcorn) |
| 스키마 브라우저 | [Redoc](./redoc.html) — 요청·응답 스키마 상세 |
| 스펙 원문 | [openapi.yaml](./openapi.yaml) (OpenAPI 3.1.0) |
| 연동 코드 생성 | [MCP 서버](https://github.com/keumbang/goldpopcon-openapi-mcp#readme) — AI 코딩 어시스턴트가 서명 코드를 만들어 준다 |

## 엔드포인트

| 메서드 | 경로 | operationId | 설명 | 권한 | 멱등키 | rate |
|---|---|---|---|---|---|---|
| `GET` | `/open/v1/prices` | `getPrices` | 금·은 시세 조회 | none (모든 키 허용) | — | quote |
| `GET` | `/open/v1/balances` | `getBalances` | 잔고·평가손익 조회 | none (모든 키 허용) | — | quote |
| `GET` | `/open/v1/prices/history` | `getPriceHistory` | 시세 이력(OHLC 캔들) 조회 | none (모든 키 허용) | — | quote |
| `GET` | `/open/v1/orders/preview` | `getOrderPreview` | 주문 가능 수량 조회 | allow_trade | — | trade |
| `GET` | `/open/v1/orders/history` | `getTradeHistory` | 체결 이력 조회 | none (모든 키 허용) | — | quote |
| `POST` | `/open/v1/buy/{asset}` | `buyAsset` | 금·은 매수 | allow_trade | 필수 | trade |
| `POST` | `/open/v1/sell/{asset}` | `sellAsset` | 금·은 매도 | allow_trade | 필수 | trade |
| `POST` | `/open/demo/v1/buy/{asset}` | `demoBuyAsset` | 금·은 데모 매수 (실자금 이동 없음) | allow_trade | — | trade |
| `POST` | `/open/demo/v1/sell/{asset}` | `demoSellAsset` | 금·은 데모 매도 (실자금 이동 없음) | allow_trade | — | trade |
| `POST` | `/open/v1/virtual-accounts` | `createVirtualAccount` | 입금용 가상계좌 발급 | allow_vacct | 필수 | trade |
| `POST` | `/open/v1/payouts` | `createPayout` | 출금 신청 | allow_payout | 필수 | trade |

경로는 Base URL 뒤에 붙는다 — `https://api.goldpopcon.com/api/open/v1/prices`.

---

골드팝콘 앱 사용자가 앱에서 직접 API 키를 발급받아, 프로그래밍 방식으로 금·은을 거래하고
입출금을 처리하는 API다. 업비트/바이낸스의 개인 API 키와 같은 모델이며, 중개하는
파트너사가 없다 — **키 소유자 = 거래 주체 = 본인**이다.

---

## 1. 빠른 시작

첫 주문까지 다섯 단계다. 각 단계는 앞 단계가 성공해야 의미가 있으므로 순서대로
확인하는 편이 빠르다.

| # | 할 일 | 확인 방법 | 막히면 |
|---|---|---|---|
| 1 | 앱에서 키 발급 | `access_key`, `secret_key` 확보 | `secret_key` 는 이 화면에서만 나온다. 놓쳤으면 폐기 후 재발급 |
| 2 | 서명 통과 확인 | `GET /open/v1/prices` 가 200 | 401이면 "3. 인증"의 서명 예제와 대조 |
| 3 | 잔고 확인 | `GET /open/v1/balances` | 주문에 쓸 값은 `krw_available`·`available_gram` (총액 아님) |
| 4 | 주문 가능 최대치 확인 | `GET /open/v1/orders/preview?side=buy&asset=gold` | 403이면 키 한도. `limited_by` 로 원인 확인 |
| 5 | 첫 주문 | `POST /open/v1/buy/gold` + `Idempotency-Key` | 400은 규칙·잔액 문제, 500은 체결 중 실패 |

2단계를 먼저 통과시키는 것이 중요하다. 서명은 이 API 에서 가장 많이 틀리는 부분인데
`/prices` 는 본문도 쿼리도 없어 `query_hash` 계산이 빠지므로, 여기서 200이 나오면
HMAC 키 처리와 시각 클레임이 맞다는 뜻이 된다. 그다음 `/orders/preview` 로
쿼리 해시를, `/buy` 로 본문 해시를 각각 검증하면 세 가지 서명 모드를 다 확인한 것이다.

실거래 전에 연동 코드를 검증하려면 `POST /open/demo/v1/buy/{asset}` ·
`/open/demo/v1/sell/{asset}` 을 쓴다. 같은 서명·같은 응답 구조지만 자금·자산이
움직이지 않는다("데모" 태그 참조). 실거래 첫 주문은 **최소 금액(100원)에 가까운
소액**으로 하는 것을 권한다 — `/open/v1/*` 주문은 전부 실제 자금으로 즉시 체결된다.

시작 전 확인할 것:

- 서버 시계가 NTP 로 동기화돼 있어야 한다. `iat` 가 서버 시각보다 30초 넘게 미래면
  전량 401이다
- 응답 시각은 RFC3339 이며 오프셋이 `Z`(UTC) 또는 `+09:00`(KST) 로 섞여 올 수 있다.
  문자열 비교 대신 파싱해서 쓴다
- 체결 이력은 `GET /open/v1/orders/history` 로 조회한다(커서 페이지네이션, 최신순).
  앱에서 낸 주문의 체결도 함께 나온다. 다만 주문 응답의 `order_id`, `matched_id`,
  `matched_at`, `total_cash_krw` 는 클라이언트도 보관해 두는 편이 안전하다 —
  네트워크 오류로 응답을 놓친 주문을 이력과 대조할 때 근거가 된다.
  현재 잔고와 평가손익은 `GET /open/v1/balances` 로 언제든 볼 수 있다

## 2. 키 발급

키는 **골드팝콘 앱에서 직접 발급한다.** 앱 로그인 후 생체 인증 또는 6자리 거래 PIN을
통과해야 발급되며, 이 시점의 본인확인이 **이후 모든 API 호출의 인증 근거**가 된다.
그래서 Open API 호출에는 별도의 생체/PIN 인증이 없다. 발급 화면에서 권한 플래그,
금액 한도, IP 화이트리스트를 함께 정한다.

발급 시 두 값을 받는다.

| 값 | 용도 | 재조회 |
|---|---|---|
| `access_key` (`gpk_` + 32자) | JWT `access_key` 클레임에 넣는다 | 앱에서 다시 볼 수 있다 |
| `secret_key` (`sk_` + 64자) | HMAC 서명 키. 전송하지 않는다 | **불가 — 발급 화면에서만 노출** |

`secret_key` 는 서버가 암호화해 보관하며 어떤 경로로도 다시 내려주지 않는다.
분실하면 그 키를 폐기하고 새로 발급하는 것 외에 방법이 없다. 키가 유출된 것 같으면
앱에서 즉시 폐기한다 — 폐기 즉시 해당 키의 모든 요청이 403이 된다.

키 발급·폐기 경로 자체는 앱 클라이언트용 내부 API이며 이 문서의 대상이 아니다.

## 3. 인증 — 요청마다 JWT 서명

모든 Open API 요청은 `Authorization: Bearer <JWT>` 를 요구한다. 이 JWT는 로그인
토큰이 아니라 **요청 하나마다 새로 만드는 서명**이다.

```
header   { "alg": "HS256", "typ": "JWT" }
payload  {
           "access_key":     "gpk_...",
           "nonce":          "<uuid-v4>",     // 요청마다 새 값
           "iat":            <unix seconds>,
           "exp":            <unix seconds>,
           "query_hash":     "<sha512 hex>",  // 페이로드가 있을 때만
           "query_hash_alg": "SHA512"
         }
서명     HMAC-SHA256(secret_key)
```

HMAC 키는 발급받은 `secret_key` 문자열(`sk_` 접두사 포함) **그대로**의 바이트다.
base64 디코딩이나 접두사 제거를 하지 않는다.

### query_hash — 업비트와 갈리는 지점

JWT 구조와 서명 알고리즘은 업비트와 같지만, **`query_hash` 의 입력이 다르다.**
업비트 예제 코드를 그대로 옮기면 전부 401이 난다.

| 메서드 | 해시 입력 |
|---|---|
| `POST` / `PUT` / `PATCH` | **요청 본문 raw 바이트** |
| 그 외 (`GET` / `DELETE`) | 정규화한 querystring |

업비트는 POST에서도 JSON을 querystring으로 바꿔 해시하지만, 그 변환은 float 표기에서
모호하다(`1.0` 과 `1` 이 같은 값인데 다른 문자열이 된다). 그래서 본문은 보낸 바이트
그대로 해시한다. **직렬화한 문자열을 그대로 서명하고 그대로 전송해야 한다** — 서명 후
본문을 재직렬화하면 공백 하나 차이로도 실패한다.

정규화 querystring 규칙:

1. 키를 오름차순 정렬
2. 같은 키에 값이 여럿이면 값도 오름차순 정렬
3. `k=v` 를 `&` 로 연결
4. **퍼센트 디코딩된 값**을 쓴다 (서버가 `URL.Query()` 로 디코딩한 뒤 비교한다).
   `from=2026-07-21T00%3A00%3A00Z` 는 `from=2026-07-21T00:00:00Z` 로 계산한다

해시는 SHA512의 **소문자 hex** 문자열이다.

본문도 쿼리 파라미터도 없는 요청(`GET /open/v1/prices`)은 `query_hash` 와
`query_hash_alg` 를 생략한다.

### 시각 클레임과 nonce

- `iat`, `exp` 는 **필수**다. 없으면 401
- `exp - iat` 는 최대 **60초**. 더 길면 401
- `iat` 가 현재보다 **30초** 넘게 미래면 401 (시계 오차 허용치)
- `nonce` 는 키별로 1회용이다. 재사용하면 401. 유효 기간 **180초**

nonce 유효 기간(180초)이 토큰 최대 수명(60초) + 시계 오차(30초)보다 길다. 이 관계가
깨지면 nonce 만료 직후 토큰 재생이 가능해지므로 서버 부팅 시 강제 검증한다.

### 401 진단

인증 실패는 원인을 구분하지 않고 모두 `401 / "인증에 실패했습니다"` 로 응답한다.
"키 없음"과 "서명 불일치"를 구분해 주면 공격자가 유효한 `access_key` 를 탐색할 수 있다.
로컬에서 서명값을 재계산해 대조하는 것이 유일한 진단 방법이다.

### 서명 예제

세 예제가 각각 다른 `query_hash` 모드를 보여준다 — 본문 해시, 쿼리 해시, 생략.

**Python** — `POST /open/v1/sell/gold` (본문 해시). `pip install pyjwt requests`

```python
import jwt, uuid, hashlib, time, requests

ACCESS_KEY = "gpk_발급받은_값"
SECRET_KEY = "sk_발급받은_값"   # HMAC 키로 문자열 그대로 사용 (base64 디코딩 금지)

body = '{"quantity":0.001,"sell_all":true}'   # 서명한 바이트를 그대로 전송한다
now = int(time.time())
payload = {
    "access_key": ACCESS_KEY,
    "nonce": str(uuid.uuid4()),              # 요청마다 새 값
    "iat": now,
    "exp": now + 30,                         # 수명 ≤ 60초
    "query_hash": hashlib.sha512(body.encode()).hexdigest(),
    "query_hash_alg": "SHA512",
}
token = jwt.encode(payload, SECRET_KEY, algorithm="HS256")

resp = requests.post(
    "https://api.goldpopcon.com/api/open/v1/sell/gold",
    data=body,                               # json= 를 쓰면 재직렬화돼 401 이 난다
    headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Idempotency-Key": str(uuid.uuid4()),   # 재시도 시 같은 키를 다시 쓴다
    },
)
print(resp.status_code, resp.text)
```

**Node 18+** — `GET /open/v1/orders/preview` (정규화 querystring 해시). 의존성 없음

```javascript
import { createHmac, createHash, randomUUID } from "node:crypto";

const ACCESS_KEY = "gpk_발급받은_값";
const SECRET_KEY = "sk_발급받은_값";
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const params = { side: "sell", asset: "gold" };
const canonical = Object.entries(params)
  .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => [k, String(x)]))
  .sort((a, b) => (a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : 1))
  .map(([k, v]) => `${k}=${v}`)
  .join("&");                                 // "asset=gold&side=sell"

const now = Math.floor(Date.now() / 1000);
const payload = {
  access_key: ACCESS_KEY,
  nonce: randomUUID(),
  iat: now,
  exp: now + 30,
  query_hash: createHash("sha512").update(canonical).digest("hex"),
  query_hash_alg: "SHA512",
};

const signingInput =
  b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }))) + "." +
  b64url(Buffer.from(JSON.stringify(payload)));
const token = signingInput + "." +
  b64url(createHmac("sha256", SECRET_KEY).update(signingInput).digest());

const res = await fetch(
  `https://api.goldpopcon.com/api/open/v1/orders/preview?${new URLSearchParams(params)}`,
  { headers: { Authorization: `Bearer ${token}` } },
);
console.log(res.status, await res.text());
```

**Go** — `GET /open/v1/prices` (본문·쿼리 없음 → 해시 생략). 표준 라이브러리만

```go
package main

import (
    "crypto/hmac"
    "crypto/rand"
    "crypto/sha256"
    "encoding/base64"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "time"
)

const (
    accessKey = "gpk_발급받은_값"
    secretKey = "sk_발급받은_값"
)

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func uuidV4() string {
    b := make([]byte, 16)
    rand.Read(b)
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func main() {
    now := time.Now().Unix()
    payload := map[string]any{
        "access_key": accessKey,
        "nonce":      uuidV4(),
        "iat":        now,
        "exp":        now + 30,
    } // query_hash / query_hash_alg 없음

    h, _ := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
    p, _ := json.Marshal(payload)
    signingInput := b64url(h) + "." + b64url(p)

    mac := hmac.New(sha256.New, []byte(secretKey))
    mac.Write([]byte(signingInput))
    token := signingInput + "." + b64url(mac.Sum(nil))

    req, _ := http.NewRequest("GET", "https://api.goldpopcon.com/api/open/v1/prices", nil)
    req.Header.Set("Authorization", "Bearer "+token)

    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        panic(err)
    }
    defer resp.Body.Close()
    out, _ := io.ReadAll(resp.Body)
    fmt.Println(resp.StatusCode, string(out))
}
```

## 4. 권한 스코프

키마다 세 플래그가 독립적으로 켜진다. 시세 조회는 플래그 없이 모든 키에 허용된다.

| 플래그 | 기본값 | 대상 |
|---|---|---|
| `allow_trade` | 켜짐 | `/buy/*`, `/sell/*`, `/orders/preview`, `/open/demo/v1/*` |
| `allow_vacct` | 꺼짐 | `/virtual-accounts` |
| `allow_payout` | **꺼짐** | `/payouts` |

플래그가 필요 없는 경로는 `/prices`, `/prices/history`, `/balances`,
`/orders/history` 넷이다.

권한이 없으면 403이다. 401(인증 실패)과 구분된다 — 403은 서명이 유효했다는 뜻이다.

## 5. 한도

| 항목 | 단위 | 미지정 시 |
|---|---|---|
| `per_request_trade_limit` | 원 | 무제한 |
| `per_request_payout_limit` | 원 | 무제한 |
| `daily_trade_limit` | 원 | 무제한 |
| `daily_payout_limit` | 원 | 무제한 |

일일 한도는 **성공(2xx) 요청만** 집계한다. 실패한 요청이 한도를 갉아먹지 않는다.
정산 근거는 서버의 요청 로그다.

일일 사용분은 **KST(UTC+9) 자정에 리셋**된다. 호출자의 로컬 시간대와 무관하다.
거래 한도와 출금 한도는 서로 다른 통이다 — 매수·매도는 **합산**해서
`daily_trade_limit` 에, 출금은 따로 `daily_payout_limit` 에 쌓인다. 사고팔기를
반복해도 거래 한도를 우회할 수 없다.

한도 검사에 쓰는 금액은 요청 종류마다 다르다.

| 요청 | 검사 금액 |
|---|---|
| 매수·매도 | 요청 수량 × 시세(매수 ask / 매도 bid), 원 미만 절사 |
| 전량매도(`sell_all: true`) | **가용 잔량** × bid, 원 미만 **올림** — 요청 `quantity` 는 무시된다 |
| 출금 | 본문 `cash_amount` 그대로 |

두 한도 모두 무제한인 키는 금액 추정 자체를 생략한다.

전량매도의 가용 잔량을 조회하지 못하면 요청 `quantity` 로 대체하지 않고 **503으로
거부**한다(fail-closed). 작은 더미 수량으로 한도를 우회할 수 있기 때문이다.
일일 사용분 조회가 실패할 때도 같은 이유로 503이다.

한도 집행은 멱등성 처리 **뒤**에 있다. 같은 `Idempotency-Key` 재생 응답은 핸들러를
실행하지 않으므로 한도를 다시 깎지 않는다.

## 6. Rate limit

버킷이 스코프별로 나뉜다. 시세 폴링이 거래 한도를 잠식하지 않게 하기 위함이다.

| 버킷 | 대상 | 기본값 |
|---|---|---|
| `quote` | `/prices`, `/prices/history`, `/balances`, `/orders/history` | 600 회/분 |
| `trade` | 나머지 전부 | 60 회/분 |

고정 윈도(매분 0초 리셋)다. 인증을 통과한 요청의 응답에 `X-RateLimit-Limit`,
`X-RateLimit-Remaining`, `X-RateLimit-Reset` 이 실린다. 초과하면 429 +
`Retry-After`.

401 응답에는 이 헤더가 없다(rate limit 이 인증 뒤에 있다). 카운터 저장소 장애 시에도
헤더 없이 통과시킨다(fail-open) — 헤더 부재를 "한도 소진" 으로 읽으면 안 된다.

## 7. 멱등성

자금이 움직이는 요청(`/buy/*`, `/sell/*`, `/virtual-accounts`, `/payouts`)은
`Idempotency-Key` 헤더가 **필수**다. **UUID v4 형식만** 허용한다.

같은 키로 재요청하면 최초 응답을 그대로 재현하고 `Idempotent-Replay: true` 헤더를
붙인다. 주문은 다시 체결되지 않는다.

키 범위는 **유저 단위**다. 같은 유저가 두 개의 API 키를 써도 같은 멱등키는 한 번만
실행된다.

> **재시도 주의** — 네트워크 오류로 응답을 못 받았을 때는 **같은** `Idempotency-Key` 로
> 재시도해야 한다. 새 키로 재시도하면 서버는 별개 주문으로 처리해 이중 체결된다.

## 8. 단위

골드팝콘 내부 시세는 금이 **1돈(3.75g)** 단위, 은이 **1g** 단위로 들어온다.
반면 **주문 수량은 금·은 모두 g** 이다.

이 API는 금 시세를 원본(`*_per_don`)과 g 환산값(`*_per_gram`)으로 함께 내려준다.
환산은 `가격 ÷ 3.75` 의 **정수 절사**이며, 주문 체결 경로와 동일한 규칙이다. 따라서
`gold.ask_per_gram` 을 그대로 예상 체결 단가로 쓸 수 있다.

수량은 소수 g 를 허용한다(예: `0.01`).

## 9. 응답 봉투

성공:

```json
{ "success": true, "message": "Successfully get prices", "data": { } }
```

실패는 두 형태가 있다. 핸들러가 낸 도메인 에러는 `error` 에 코드가 담기고,
미들웨어가 낸 에러(인증·rate limit)는 `error` 가 `null` 이며 `message` 만 있다.

```json
{ "success": false, "message": "failed to create order",
  "error": { "code": "P0001", "error": "지갑 잔액이 부족합니다" } }

{ "success": false, "message": "인증에 실패했습니다", "error": null }
```

## 10. 에러 코드

| 코드 | 상태 | 의미 |
|---|---|---|
| `U0005` | 400 | 입력 형식 오류 |
| `N0001` | 404 | 리소스 없음 (마켓 등) |
| `S0001` | 500·502·503 | 서버 또는 상류 시스템 오류. **프로덕션 500 응답에서는 마스킹되어 `error` 가 `null` 이다** — 5xx 분기는 상태 코드로만 한다 |
| `P0001` | 400 | 잔액·보유 수량 부족, 주문 금액 0원, 전량매도 잔량 없음 |
| `M0001` | 400 | 최소 주문 수량 미달 (금 0.001g, 은 0.1g) |
| `M0002` | 400 | 주문 단위(0.001g) 위반 — 수량이 0.001g 배수가 아님 |
| `M0003` | 400 | 최소 주문 금액(100원) 미달 — 시세×수량이 100원 미만 |
| `L0001` | 403 | 금액 한도 초과 (건당 또는 일일). `error` 에 상세가 실린다 |

> **잔액 부족은 `400 / P0001` 이다.** 주문 경로가 체결 전에 가용 현금(매수)과
> 가용 수량(매도)을 먼저 검사한다. 두 값 모두 **미체결 주문에 묶인 몫을 뺀** 가용분
> 기준이라, 총 잔고는 충분한데 미체결 주문 때문에 거절될 수 있다. 메시지에 필요액과
> 가용액이 함께 실린다.
>
> 사전 검사를 통과한 뒤 상류 이체가 실패하면 그때는 `500 / S0001` 이다. 즉
> **400은 "낼 수 없는 주문", 500은 "내다가 깨진 주문"** 으로 갈린다. 주문 전에
> `GET /open/v1/orders/preview` 로 가용 최대치를 확인하는 편이 안전하다.
