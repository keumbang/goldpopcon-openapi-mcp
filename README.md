# @keumbang/openapi-mcp

금방(Keumbang) Open API **코딩 어시스턴트 MCP 서버**. Claude Desktop · Cursor · Cline 등 MCP 클라이언트에 붙여, 금·은 거래 API 연동 코드를 정확히 짜도록 돕는다.

이 API에서 개발자가 막히는 지점은 필드명이 아니라 **요청 서명**이다 — `query_hash` 입력이 메서드에 따라 갈리고(POST=raw body, GET=정규화 querystring) 업비트 예제를 그대로 옮기면 전부 401이 난다. 이 MCP는 그 절차를 코드로 생성하고 로컬에서 서명/검증까지 해준다.

## 도구

| 도구 | 용도 |
|---|---|
| `list_endpoints` | 엔드포인트 목록 — 권한 스코프·멱등성·rate 버킷 포함 |
| `get_endpoint` | 단일 엔드포인트 상세 — 파라미터·본문 스키마·예제·응답·에러 |
| `list_error_codes` | 에러 코드 표 + 함정(잔액 부족=500 S0001, 인증 실패=401 error:null) |
| `signing_guide` | JWT 서명 절차 — `query_hash` 분기·시각 클레임·nonce·멱등성 |
| `generate_signed_request` | 언어별(python/javascript/go/curl) 완결형 서명 요청 코드 생성 |
| `sign_request` | 실제 키로 JWT를 **로컬 계산**(디버깅) — JWT·query_hash·바로 쓸 curl 반환 |
| `verify_signature` | 이미 만든 JWT를 서버와 같은 순서로 검증 — 401 원인 진단 |
| `call_api` *(opt-in)* | 실제 호출 — **조회 전용·staging 고정**. env 로 켤 때만 등록 |

리소스: `keumbang://openapi.yaml`(전체 스펙), `keumbang://overview`(서명·한도·에러 산문).

> **보안**: `sign_request`/`verify_signature`/`call_api`에 넘긴 `secret_key`는 로컬 서명에만 쓰이고 서명 결과(JWT)만 전송된다 — secret 자체는 네트워크를 타지 않는다.

### call_api — 조회 전용 라이브 호출

기본 **비활성**. `KEUMBANG_MCP_ALLOW_LIVE=true` 일 때만 등록된다. 4중 안전장치로 자금 이동을 원천 차단:

1. **env 게이트** — 변수 없으면 도구 자체가 없다
2. **화이트리스트** — `getPrices` / `getBalances` / `getPriceHistory` / `getOrderPreview` 만. `buy`·`sell`·`payout`·`virtual-accounts` 는 라이브 불가(코드 생성만)
3. **staging 고정** — production/임의 url 지정 불가
4. **GET 강제** — 쓰기 메서드 차단

자금 이동 엔드포인트를 실제로 호출하려면 `generate_signed_request` 로 코드를 받아 개발자 본인 환경에서 실행한다.

## 설치 · 빌드

```bash
git clone https://github.com/keumbang/keumbang-openapi-mcp.git
cd keumbang-openapi-mcp
npm install
npm run build       # dist/ 생성
npm test            # 서명 회귀 테스트
```

## MCP 클라이언트 등록

배포 후(npm publish 시) — 권장:

```json
{ "mcpServers": { "keumbang-openapi": { "command": "npx", "args": ["-y", "@keumbang/openapi-mcp"] } } }
```

로컬 클론 실행:

```json
{
  "mcpServers": {
    "keumbang-openapi": {
      "command": "node",
      "args": ["/절대경로/keumbang-openapi-mcp/dist/index.js"]
    }
  }
}
```

Claude Desktop `claude_desktop_config.json`, Cursor `~/.cursor/mcp.json`. 개발 중엔 `command: "npx", args: ["tsx", "/절대경로/.../src/index.ts"]`.

## 환경변수

| 변수 | 기본 | 의미 |
|---|---|---|
| `KEUMBANG_OPENAPI_SPEC` | 번들 `spec/openapi.yaml` | 스펙 파일 경로 재지정 |
| `KEUMBANG_MCP_ALLOW_LIVE` | (없음) | `true` 면 `call_api`(조회 전용·staging) 활성화 |

## 예시 대화

- "sellAsset 을 파이썬으로 호출하는 코드 줘, 금 0.5g" → `generate_signed_request(operationId=sellAsset, language=python, pathParams={asset:gold}, body={quantity:0.5})`
- "이 JWT 가 왜 401 나?" → `verify_signature(token=..., secretKey=..., method=POST, rawBody=...)`
- "가격 이력 엔드포인트 파라미터 뭐야?" → `get_endpoint(operationId=getPriceHistory)`

## 스펙 동기화

스펙 원본은 **<backend-repo> repo 의 `docs/openapi.yaml`**(이 repo 밖)이고, 이 repo 는 `spec/openapi.yaml` 사본을 번들한다. 원본이 바뀌면 `SPEC_SRC` 로 경로를 지정해 갱신한다:

```bash
SPEC_SRC=/path/to/<backend-repo>/docs/openapi.yaml npm run sync-spec
```
(<backend-repo> 을 sibling 으로 클론했으면 `../<backend-repo>/docs/openapi.yaml` 가 기본값이라 인자 없이 `npm run sync-spec`.)

갱신 후 `spec/openapi.yaml` 을 커밋한다. 서명 규칙이 서버와 어긋나면 `npm test`(서버 검증 규칙 미러)가 잡는다.
```
<backend-repo>/docs/openapi.yaml  ──sync-spec──▶  spec/openapi.yaml
```
