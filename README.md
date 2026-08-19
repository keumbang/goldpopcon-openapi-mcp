# @keumbang/goldpopcon-openapi-mcp

[![npm](https://img.shields.io/npm/v/@keumbang/goldpopcon-openapi-mcp)](https://www.npmjs.com/package/@keumbang/goldpopcon-openapi-mcp)
[![CI](https://github.com/keumbang/goldpopcon-openapi-mcp/actions/workflows/publish.yml/badge.svg)](https://github.com/keumbang/goldpopcon-openapi-mcp/actions/workflows/publish.yml)
[![node](https://img.shields.io/node/v/@keumbang/goldpopcon-openapi-mcp)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@keumbang/goldpopcon-openapi-mcp)](./LICENSE)

[![VS Code 설치](https://img.shields.io/badge/VS_Code-설치-0098FF?logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=goldpopcon-openapi&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40keumbang%2Fgoldpopcon-openapi-mcp%22%5D%7D)
[![Cursor 설치](https://img.shields.io/badge/Cursor-설치-000000?logo=cursor&logoColor=white)](https://cursor.com/install-mcp?name=goldpopcon-openapi&config=eyJjb21tYW5kIjoibnB4IC15IEBrZXVtYmFuZy9nb2xkcG9wY29uLW9wZW5hcGktbWNwIn0%3D)

골드팝콘(금방) Open API **코딩 어시스턴트 MCP 서버**. Claude Code · Claude Desktop · Codex CLI · Gemini CLI · Cursor 등 MCP 클라이언트에 붙여, 금·은 거래 API 연동 코드를 정확히 짜도록 돕는다.

> ### 📘 골드팝콘 Open API 문서 → **[https://keumbang.github.io/goldpopcon-openapi-mcp/](https://keumbang.github.io/goldpopcon-openapi-mcp/)**
>
> 엔드포인트 표 · 빠른 시작 · JWT 서명 규격 · 권한/한도 · 멱등성 · 에러 코드. 스펙에서 생성되는 공식 문서다.
> 요청·응답 스키마는 [Redoc](https://keumbang.github.io/goldpopcon-openapi-mcp/redoc.html) 에서 본다. MCP 없이 직접 연동할 사람도 여기부터 읽으면 된다.
> (repo 안에서 바로 보려면 [docs/index.md](./docs/index.md))

## API 키 발급

Open API 키(`gpk_` 액세스 키 + `sk_` 시크릿 키)는 **골드팝콘 앱에서만 발급**된다. 웹 발급 경로는 없다.

1. 골드팝콘 앱 설치 — [App Store](https://apps.apple.com/kr/app/id6747214612) · [Google Play](https://play.google.com/store/apps/details?id=com.keumbang.goldpopcorn)
2. 회원가입 후 앱 내 Open API 메뉴에서 키 발급
3. `sk_` 시크릿 키는 **발급 화면에서만 노출**된다 — 그 자리에서 안전한 곳에 보관

이 API에서 개발자가 막히는 지점은 필드명이 아니라 **요청 서명**이다 — `query_hash` 입력이 메서드에 따라 갈리고(POST=raw body, GET=정규화 querystring) 업비트 예제를 그대로 옮기면 전부 401이 난다. 이 MCP는 그 절차를 코드로 생성하고 로컬에서 서명/검증까지 해준다.

## 도구

| 도구 | 용도 |
|---|---|
| `list_endpoints` | 엔드포인트 목록 — 권한 스코프·멱등성·rate 버킷 포함 |
| `get_endpoint` | 단일 엔드포인트 상세 — 파라미터·본문 스키마·요청/성공 응답 예제·응답 코드 |
| `list_error_codes` | 에러 코드 표 + 상태 코드별 재시도 판단 + 함정(잔액 부족=400 P0001, 인증 실패=401 error:null) |
| `signing_guide` | JWT 서명 절차 — `query_hash` 분기·시각 클레임·nonce·멱등성 |
| `generate_signed_request` | 언어별(python/javascript/go/curl) 완결형 서명 요청 코드 생성 |
| `sign_request` | 실제 키로 JWT를 **로컬 계산**(디버깅) — JWT·query_hash·바로 쓸 curl 반환 |
| `verify_signature` | 이미 만든 JWT를 서버와 같은 순서로 검증 — 401 원인 진단 |
| `call_api` *(opt-in)* | 실제 호출 — **조회 전용·production 고정**. env 로 켤 때만 등록 |

리소스: `goldpopcon://openapi.yaml`(전체 스펙), `goldpopcon://overview`(서명·한도·에러 산문).

> **보안**: `sign_request`/`verify_signature`/`call_api`에 넘긴 `secret_key`는 로컬 서명에만 쓰이고 서명 결과(JWT)만 전송된다 — secret 자체는 네트워크를 타지 않는다.

### call_api — 조회 전용 라이브 호출

기본 **비활성**. `GOLDPOPCON_MCP_ALLOW_LIVE=true` 일 때만 등록된다. 4중 안전장치로 자금 이동을 원천 차단:

1. **env 게이트** — 변수 없으면 도구 자체가 없다
2. **화이트리스트** — `getPrices` / `getBalances` / `getPriceHistory` / `getOrderPreview` / `getTradeHistory` 만. `buy`·`sell`·`payout`·`virtual-accounts` 는 라이브 불가(코드 생성만)
3. **production 고정** — 인자로 서버를 바꿀 수 없다. 조회 전용이라 production 을 읽어도 자금은 움직이지 않는다
4. **GET 강제** — 쓰기 메서드 차단

자금 이동 엔드포인트를 실제로 호출하려면 `generate_signed_request` 로 코드를 받아 개발자 본인 환경에서 실행한다.

#### 읽기 자동화 — 키는 env 로

LLM 이 시세·잔고를 반복 조회하는 자동화라면 `accessKey`/`secretKey` **인자를 생략**하고 env 로 준다. 인자로 넘긴 `sk_` 는 호출마다 모델 컨텍스트·트랜스크립트·클라이언트 로그에 평문으로 남는다.

```json
{
  "mcpServers": {
    "goldpopcon-openapi": {
      "command": "npx",
      "args": ["-y", "@keumbang/goldpopcon-openapi-mcp"],
      "env": {
        "GOLDPOPCON_MCP_ALLOW_LIVE": "true",
        "GOLDPOPCON_ACCESS_KEY": "gpk_...",
        "GOLDPOPCON_SECRET_KEY": "sk_..."
      }
    }
  }
}
```

env fallback 은 `call_api`(조회 전용)에만 있다. `sign_request` 는 `buyAsset` 서명까지 만들 수 있어 열지 않았다 — 열면 에이전트가 사람 개입 없이 유효한 자금 이동 서명을 찍어낸다.

`call_api` 는 `structuredContent` 로도 응답한다 — 마크다운 파싱 없이 값을 바로 쓴다.

```json
{
  "operationId": "getPrices",
  "url": "https://api.goldpopcon.com/api/open/v1/prices",
  "status": 200,
  "ok": true,
  "data": { "...": "응답 본문 JSON 그대로" },
  "rateLimit": { "limit": 600, "remaining": 599, "reset": 1730000000, "retryAfter": null }
}
```

- `data` 형태는 엔드포인트마다 다르다 — `get_endpoint` 의 성공 응답 예제가 스펙이다.
- 4xx/5xx 도 도구 에러가 아니라 `status`/`ok` 로 온다. 루프가 분기해서 처리한다.
- JSON 이 아닌 본문(게이트웨이 HTML 오류 등)은 `data` 대신 `raw` 로 온다.
- 429 면 `rateLimit.retryAfter` 에 대기 초. quote 600/분, trade 60/분.

## 설치 · 빌드

```bash
git clone https://github.com/keumbang/goldpopcon-openapi-mcp.git
cd goldpopcon-openapi-mcp
npm install
npm run build       # dist/ 생성
npm test            # 서명 회귀 테스트
```

## MCP 클라이언트 등록

CLI 한 줄로 붙는 클라이언트:

```bash
# Claude Code
claude mcp add goldpopcon-openapi -- npx -y @keumbang/goldpopcon-openapi-mcp

# Codex CLI  (~/.codex/config.toml 에 기록된다. 세션에서 /mcp 로 연결 확인)
codex mcp add goldpopcon-openapi -- npx -y @keumbang/goldpopcon-openapi-mcp
```

설정 파일 직접 편집(Claude Desktop `claude_desktop_config.json`, Cursor `~/.cursor/mcp.json`, Gemini CLI `~/.gemini/settings.json`):

```json
{ "mcpServers": { "goldpopcon-openapi": { "command": "npx", "args": ["-y", "@keumbang/goldpopcon-openapi-mcp"] } } }
```

Gemini CLI 는 `PATH` 해석이 불안정하다 — 서버가 안 뜨면 `command` 를 `which npx` 로 얻은 절대경로로 바꾼다.

로컬 클론 실행:

```json
{
  "mcpServers": {
    "goldpopcon-openapi": {
      "command": "node",
      "args": ["/절대경로/goldpopcon-openapi-mcp/dist/index.js"]
    }
  }
}
```

개발 중엔 `command: "npx", args: ["tsx", "/절대경로/.../src/index.ts"]`.

## 환경변수

| 변수 | 기본 | 의미 |
|---|---|---|
| `GOLDPOPCON_OPENAPI_SPEC` | 번들 `spec/openapi.yaml` | 스펙 파일 경로 재지정 |
| `GOLDPOPCON_MCP_ALLOW_LIVE` | (없음) | `true` 면 `call_api`(조회 전용·production) 활성화 |
| `GOLDPOPCON_ACCESS_KEY` | (없음) | `call_api` 액세스 키 기본값 — 인자 생략 시 사용 |
| `GOLDPOPCON_SECRET_KEY` | (없음) | `call_api` 시크릿 키 기본값 — 반복 호출 자동화에서 권장 |

## 예시 대화

- "sellAsset 을 파이썬으로 호출하는 코드 줘, 금 0.5g" → `generate_signed_request(operationId=sellAsset, language=python, pathParams={asset:gold}, body={quantity:0.5})`
- "보유한 금 전부 팔려면?" → `generate_signed_request(operationId=sellAsset, language=python, pathParams={asset:gold}, body={quantity:0.001, sell_all:true})` — `sell_all` 이 요청 수량을 무시하고 가용 잔량 전량을 체결한다
- "이 JWT 가 왜 401 나?" → `verify_signature(token=..., secretKey=..., method=POST, rawBody=...)`
- "가격 이력 엔드포인트 파라미터 뭐야?" → `get_endpoint(operationId=getPriceHistory)`
- "잔액 부족이면 몇 번 에러야?" → `list_error_codes` — `400 P0001`(500 아님). 상태 코드별 재시도 판단표도 같이 나온다

## 스펙 동기화

스펙 원본은 **백엔드 repo 의 `docs/openapi.yaml`**(이 repo 밖)이고, 이 repo 는 `spec/openapi.yaml` 사본을 번들한다. 원본이 바뀌면 `SPEC_SRC` 로 경로를 지정해 갱신한다:

```bash
SPEC_SRC=/path/to/<backend-repo>/docs/openapi.yaml npm run sync-spec
```
`SPEC_SRC` 는 **필수**다. 생략하면 원본을 못 찾고 실패한다 — 백엔드 repo 명을 이 repo 에 남기지 않기 위해 기본 경로를 두지 않았다.

`dist/` 가 있으면 sync-spec 이 문서 사이트(`docs/index.md` · `docs/openapi.yaml`)도 같이 다시 만든다. 스펙만 따로 갱신했다면 `npm run docs` 로 맞춘다 — 둘 다 생성물이라 직접 고치지 않는다. 문서 내용을 바꾸려면 백엔드 스펙의 `info.description` 을 고친다. 손으로 쓰는 파일은 `docs/_config.yml` 과 `docs/redoc.html` 둘뿐이다.

갱신 후 `spec/openapi.yaml` 과 `docs/` 를 커밋한다. main 에 푸시되면 GitHub Pages 가 사이트를 다시 배포한다. 서명 규칙이 서버와 어긋나면 `npm test`(서버 검증 규칙 미러)가 잡는다.
```
<backend-repo>/docs/openapi.yaml  ──sync-spec──▶  spec/openapi.yaml  ──gen-docs──▶  docs/  ──Pages──▶  keumbang.github.io
```
