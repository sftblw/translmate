# 페이지 번역 백로그와 선행 리팩터 계획

이 문서는 페이지 번역에 필요한 기능, 현재 불편, 실패 사례, 옵션의 정확한 의미와 구현 순서를 한곳에 고정한다. 새 옵션을 급히 붙이는 대신 현재 동작을 보존하는 리팩터를 먼저 수행하고, 이후 기능은 이 문서의 상태 모델을 기준으로 추가한다.

## 제품 원칙

1. 번역은 에이전틱 루프가 수행한다.
   - 모델은 `get_next_units`로 작업을 가져오고 `submit_translations`로 결과를 제출한다.
   - 런타임이 검증, DOM 적용, 완료 여부, 재시도와 중단을 결정한다.
   - assistant의 일반 텍스트나 최종 응답을 번역 결과로 파싱하지 않는다.
2. 원문과 번역문, 구조 경계는 canonical document resource에 보존한다.
   - 대화 compaction은 문서 원문, placeholder, 번역 결과와 작업 상태를 없애지 못한다.
3. DOM 읽기와 쓰기는 content script만 수행한다.
   - 백그라운드는 직렬화 가능한 번역 단위와 작업 상태를 소유한다.
4. 표시 상태, 번역 범위, 실행 수명과 작업 제어를 서로 섞지 않는다.
5. 모델 출력은 신뢰하지 않고 구조, placeholder, 빈 결과, 중복, 누락과 적용 성공을 런타임에서 검증한다.

## 일반 사용자 UI 원칙

1. popup은 현재 탭의 번역 제어와 상태만 담당한다. 번역 범위와 실행 시점처럼 지속되는 선택은 설정 화면의 Translation 탭에 둔다.
2. turn, step, tool call, token, lease id, stop reason 같은 내부 진단은 기본 UI에 표시하지 않는다. 런타임에는 보존하고 개발자 진단 또는 내보내기에서만 제공한다.
3. 서로 충돌할 수 있는 기능은 여러 checkbox가 아니라 쉬운 문장으로 된 상호 배타적 선택지로 제공한다.
4. 진행 상태는 “번역 중”, “일시정지됨”, “완료”, “확인 필요”처럼 사용자가 다음 행동을 판단할 수 있는 말로 표현한다.
5. 오류는 내부 예외명보다 사용자가 할 수 있는 행동을 먼저 안내하고, 상세 원인은 펼쳐보기나 진단 내보내기로 분리한다.
6. 기본 화면의 주 동작은 하나로 유지하고, 결과 폐기처럼 되돌리기 어려운 동작은 시각적으로 분리한다.
7. 고급 옵션과 진단은 점진적으로 공개한다. 별도 popup UX 작업이 명시적으로 잡히기 전에는 새 기능을 이유로 popup을 재구성하지 않는다.

## 옵션 모델

다음 항목은 서로 충돌하는 boolean 체크박스로 만들지 않는다. 번역 범위와 실행 수명을 각각 하나씩 선택하는 두 개의 독립된 축으로 제공한다.

### 1. 번역 범위(coverage policy)

| 값 | 사용자 의미 | 비고 |
| --- | --- | --- |
| `reading-window` | 현재 보고 있는 곳과 가까운 곳부터 번역 | 현재 기본 동작을 유지한다. 스크롤하면 같은 세션에 새 단위를 추가한다. |
| `full-document` | 스크롤과 관계없이 현재 DOM에서 찾은 문서 끝까지 미리 번역 | 화면 근처 단위를 우선하되 나머지도 큐에 넣는다. |

- 번역 영역 선택기는 coverage policy와 별개인 추가 대상이다.
- 동적/무한 스크롤/가상 목록은 아직 DOM에 생성되지 않은 내용을 번역할 수 없다. `full-document`는 “현재 materialize된 문서 전체”를 뜻한다.
- SPA에서 새 본문이 생기면 문서 fingerprint를 비교해 변경된 단위만 추가하거나 무효화한다.

### 2. 실행 수명(run/lifecycle policy)

| 값 | 사용자 의미 | 비고 |
| --- | --- | --- |
| `while-visible` | 이 페이지를 실제로 보고 있을 때만 진행 | 숨겨지면 새 lease/모델 turn 시작을 보류한다. 사용자 취소가 아니라 일시정지다. |
| `while-tab-open` | 다른 탭을 보더라도 이 탭이 열려 있으면 진행 | 현재 동작에 가장 가깝고 초기 기본값으로 삼는다. |
| `continue-after-close` | 탭을 닫아도 번역을 계속 | DOM과 분리된 직렬화 문서/작업을 백그라운드에서 계속하고, 재방문 시 안전하게 다시 붙인다. |

- `while-visible` 전환은 원칙적으로 진행 중인 provider 호출을 취소하지 않고 turn/lease 경계에서 멈춘다. 명시적인 “취소”만 in-flight 호출을 abort한다.
- `continue-after-close` 상태에서는 닫힌 DOM에 적용할 수 없다. 번역 결과를 문서 자원에 저장하고 같은 문서를 다시 열었을 때 source fingerprint가 일치하는 단위만 적용한다.
- 탭을 닫은 뒤에도 진행하는 것과 브라우저를 완전히 종료한 뒤 재개하는 것은 다른 기능이다. 브라우저 재시작 복구에는 scheduler/job 영속화와 재수화가 추가로 필요하다.

### 3. 표시 모드(display mode)

| 값 | 의미 |
| --- | --- |
| `translated` | 적용된 번역을 표시하고, 아직 번역되지 않은 단위는 원문을 표시 |
| `original` | 원문을 표시하되 에이전트 작업과 번역 결과는 유지 |

- “원문 보기”는 번역 작업을 취소하거나 새 번역을 시작하는 버튼이 아니다.
- 표시 모드 변경은 네트워크 호출, 큐, session id와 독립적이어야 한다.
- 후속 후보: 원문/번역 나란히 보기, hover로 원문 보기, 단락별 전환, 번역 변경점 표시.

### 4. 명시적 작업 제어

- `pause`: 새 모델 turn/lease만 멈추고 현재 결과와 큐를 보존한다.
- `resume`: 같은 세션과 문서에서 재개한다.
- `cancel`: in-flight 호출을 abort하고 남은 작업을 중단하지만 적용 결과는 보존한다.
- `discard`: 번역 결과, patch state와 관련 캐시를 버리고 원문으로 되돌린다.
- `retry failed`: 실패 단위만 최신 설정과 지시로 다시 큐에 넣는다.

## 기능 및 불편 백로그

### A. 번역 대상 탐색과 강제 추가

- [ ] “번역 영역 선택” inspector의 content-script 기반 선택 엔진은 구현됐지만, popup을 변경하지 않는 별도 진입 동선을 정해야 한다.
- [ ] hover outline, 클릭 선택, Esc 취소, 선택 영역 미리보기와 선택 해제를 제공한다.
- [x] 자동 추출 결과에 선택한 root의 단위를 더하고 stable unit id로 중복 제거한다.
- [x] 선택한 root는 본문 판별, link-density, viewport 필터를 우회할 수 있다.
- [x] `script`, `style`, form 입력값, `contenteditable`, 확장 UI 등 안전 제외 규칙은 계속 적용한다.
- [ ] 너무 큰 root/body를 선택하면 예상 단위 수와 글자 수를 보여주고 확인을 받는다.
- [ ] 자동 본문 탐색 실패 시 수동 선택 진입을 눈에 띄게 제안한다.
- [ ] 자동 root 후보와 제외 이유를 inspector/debug 화면에서 확인할 수 있게 한다.
- [ ] iframe, open/closed shadow root, canvas, PDF, 가상 목록 지원 범위를 명시한다.
- [ ] 세션 기본 선택은 탭 한정으로 보존하고, 사이트별 선택자 저장은 별도 opt-in 기능으로 둔다.

### B. 번역 범위와 우선순위

- [x] `reading-window`를 명시적인 기본 coverage policy로 만든다.
- [x] `full-document`를 추가하고 viewport → near viewport → 나머지 document order 순으로 lease한다.
- [ ] 스크롤/resize/DOM mutation 이벤트를 coalesce하고 이미 알려진 단위는 재전송하지 않는다.
- [x] 화면 이동이 완료 단위를 재번역하지 않도록 source fingerprint와 상태를 유지한다.
- [ ] 동적 문서에서 새 단위, 수정된 단위, 제거된 단위를 구분한다.
- [ ] 문서 전체 작업의 단위 수/글자 수/대략적인 비용을 시작 전에 보여주는 선택지를 검토한다.
- [ ] 수동 선택 대상은 자동 coverage와 합쳐지되 우선순위를 별도로 줄 수 있게 한다.

### C. 실행 수명, 탭 연결과 영속화

- [ ] `while-visible`, `while-tab-open`, `continue-after-close`를 상호 배타적인 run policy로 제공한다.
- [x] document/job id를 tab id와 분리하고 한 작업에 live tab attachment가 0개 또는 1개일 수 있게 한다.
- [x] content script의 visibility/focus 상태를 백그라운드 scheduler에 전달한다.
- [ ] 일시정지 사유를 `user`, `hidden`, `offline`, `rate-limit`, `provider` 등으로 구분한다.
- [ ] 탭 종료 시 정책에 따라 cancel하거나 detached 상태로 전환한다.
- [ ] detached 결과를 URL만이 아니라 canonical URL, source fingerprint, 언어, 모델/프롬프트 버전과 함께 저장한다.
- [ ] 재방문 시 같은 source fingerprint인 단위만 적용하고 변경된 단위는 다시 번역한다.
- [ ] 브라우저 재시작 후 작업 복구는 별도 단계로 구현한다.
- [ ] private browsing, 저장 용량, TTL, 삭제 UI와 민감 페이지 제외 정책을 먼저 결정한다.
- [ ] 오프라인, 서비스 워커/백그라운드 종료, 확장 업데이트 중인 작업의 복구 규칙을 정의한다.

### D. 원문 보기와 표시 UX

- [x] 표시 모드를 작업 수명과 완전히 분리한다.
- [ ] popup에 “번역 중”, “숨김으로 일시정지”, “탭 없이 번역 중”, “재연결 대기”, “원문 표시 중”을 구분해 표시한다.
- [ ] 원문 보기 상태에서도 번역 진행률과 완료 알림을 볼 수 있게 한다.
- [x] 원문/번역 토글이 번역 요청을 새로 보내지 않는다는 회귀 테스트를 둔다.
- [x] 부분 적용 상태에서 원문과 번역을 오갈 때 DOM 원문 snapshot을 훼손하지 않는다.
- [x] 페이지 자체 mutation과 번역 patch mutation을 구분한다.
- [ ] 재번역, 번역 취소, 결과 폐기의 차이를 버튼 문구와 확인 절차로 명확히 한다.
- [ ] 단락별 원문 보기와 접근 가능한 키보드 조작을 후속 검토한다.

### E. 구조, 공백과 줄바꿈 보존

- [x] 모델 입력은 문자열 escape인 `\n`/`\\n`을 레이아웃 표식으로 사용하지 않는다.
- [x] 원문의 구조 경계는 명시적인 inline wrapper와 structural boundary로 전달한다.
- [x] `<br>`과 보존해야 하는 줄바꿈은 구조 토큰/경계로 모델에 전달하고 동일한 placeholder 검증 대상에 포함한다.
- [x] 모델이 번역문 내부 공백을 자연스럽게 선택할 수 있게 하되 구조 토큰을 삭제, 복제, 텍스트화하지 못하게 검증한다.
- [x] DOM 적용 단계에서 escape 문자열을 임의로 제거하는 후처리에 의존하지 않는다.
- [x] 문단 첫 글자가 `n`으로 남는 사례, 화면에 `\n`이 보이는 사례, 중복 역슬래시 사례를 fixture로 고정한다.
- [ ] inline span 순서 재배치는 현재 허용하지 않는다. 필요한 경우 wrapper id 보존과 안전한 DOM 재조립 설계를 별도로 한다.
- [ ] span 순서를 유지해 한국어 어순이 부자연스러운 사례를 수집하고, 단일 번역 단위 경계 개선과 few-shot 예제로 우선 완화한다.
- [ ] `pre`, `code`, 표, 목록, 각주, 캡션과 mixed inline formatting의 정책을 명시한다.
- [x] 현재의 단일 `domHint` 대신 block tag, 목록 종류/깊이/순번과 각 span의 allowlist된 inline tag를 모델 입력 구조에 포함한다.
- [x] Blockly형 목록과 inline link fixture로 구조 메타데이터가 lease까지 보존되는지 고정한다.
- [x] 모델 출력은 XML을 재현하지 않고 schema-native `translatedSpans` 배열로 제출하며 실제 DiffusionGemma endpoint로 검증한다.

#### 구현된 구조 전달 계약

초기 `sN:tagname` 계열 표현의 목적은 placeholder 식별만이 아니라 모델에 DOM 의미를 전달하는 것이었다. 이전 계약은 block의 `domHint` 하나와 일반적인 `<s1>`, `<s2>`만 노출해 다음 정보를 잃고 있었다.

- `li`가 `ul`/`ol` 중 어디에 속하는지, 목록 깊이와 항목 순번
- 각 span이 일반 텍스트, 링크, 강조 중 어디에서 나온 것인지
- 서로 인접한 단위가 같은 목록이나 의미 그룹에 속하는지

입력은 이 의미를 다시 제공하되 raw DOM 전체나 임의 attribute를 노출하지 않는다. 예:

```xml
<unit tag="li" parent="ul" list-kind="unordered" list-depth="1" list-index="2" list-id="list-1">
  <s1 tag="strong">Fully featured.</s1>
  <s2 tag="#text"> Plus it has a thriving </s2>
  <s3 tag="a">plugin ecosystem</s3>
  <s4 tag="#text"> that gives you even more capabilities.</s4>
</unit>
```

출력 계약은 입력 표현과 다르게 구현했다. JSON tool argument 안에 XML 문자열을 다시 작성하게 하면 모델이 `</s2>`를 `</s3>`로 잘못 닫는 순간 번역 내용까지 거부되므로 다음과 같이 제출한다.

```json
{
  "unitId": "unit-13",
  "translatedSpans": [
    { "slot": 1, "text": "완전한 기능을 제공합니다." },
    { "slot": 2, "text": " 또한 활발한 " },
    { "slot": 3, "text": "플러그인 생태계" },
    { "slot": 4, "text": "를 통해 더 많은 기능을 사용할 수 있습니다." }
  ]
}
```

- 모델은 각 `text`의 앞뒤 공백, 조사와 문장부호를 자유롭게 배분한다. 런타임은 이를 trim하지 않는다.
- slot 순서, 개수, `<br>` 경계와 DOM node 대응은 런타임이 소유한다.
- 모델은 구조를 읽어 번역 판단에 사용하지만 닫는 태그를 재현할 책임은 지지 않는다.
- inline 순서 재배치는 별도 DOM 재조립 계약이 생기기 전까지 허용하지 않는다.
- 원문 DOM attribute와 URL은 모델용 구조 메타데이터에 포함하지 않는다.
- `nvidia/diffusiongemma-26B-A4B-it-NVFP4` 실제 tool-call smoke test에서 구조 입력, slot 제출과 런타임 `<br/>` 복원을 확인했다.

### F. 에이전틱 루프 안정성

- [x] 매 turn에서 모델이 `get_next_units`와 `submit_translations`를 사용하도록 유지한다.
- [ ] tool-call arguments가 여러 stream delta로 나뉘거나 첫 delta가 빈 문자열이어도 완성된 JSON만 실행한다.
- [ ] 빈 translations, 알 수 없는 lease, 만료 lease, 중복 submit, stale session을 구분해 처리한다.
- [x] 모델이 일반 텍스트로 멈추거나 도구를 호출하지 않을 때 runtime continuation을 제한 횟수만큼 예약한다.
- [x] step limit, turn timeout, 전체 stall timeout과 repair budget을 서로 다른 중단 사유로 기록한다.
- [x] 정상적인 작은 lease 순회는 repair attempt를 소모하지 않는다.
- [x] DOM apply 실패가 반복되면 동일 단위를 무한 lease하지 않고 원인과 source fingerprint를 기록해 격리한다.
- [x] provider retry는 비용 중복을 피하도록 기본 비활성화하고 명시적인 정책으로만 허용한다.
- [x] 설정 변경은 현재 turn 뒤 같은 actor inbox를 통해 적용하고 중복 actor/요청을 만들지 않는다.
- [x] 컨텍스트 compaction은 chat/event history만 줄이고 document resource와 scheduler state는 보존한다.
- [x] 토큰 예산, 실제 input/output token, tool step, finish/stop reason을 관측 가능하게 한다.
- [x] 일부 단위가 격리 실패한 세션은 다른 단위가 성공했더라도 `completed`로 표시하지 않는다.

### G. 번역 품질과 프롬프트

- [ ] 짧고 안정적인 system rule과 도구 계약을 유지하고 반복 설명은 제거한다.
- [ ] 공백/inline wrapper/한국어 어순의 대표적인 few-shot 예제를 소수만 둔다.
- [ ] “재배치해라”처럼 현재 DOM patch 계약으로 수행할 수 없는 지시는 넣지 않는다.
- [ ] 제목, 본문, 목록, 캡션, UI 문구의 tone 차이를 unit metadata로 전달할지 검토한다.
- [ ] 앞 단위의 용어와 문맥을 `contextForNext` 및 문서 인접 단위로 제공한다.
- [ ] 모델별 tool-use 호환성 테스트와 최소 step/token 권장값을 provider preset으로 관리한다.
- [ ] 동일 fixture에 대해 placeholder 보존, 완결성, 유창성의 회귀 평가를 둔다.

### H. 관측성, 진단과 복구

- [ ] session id, document id, attachment tab id, turn id, lease id와 unit id를 로그에서 연결한다.
- [ ] 상태 전이와 이유, queue 길이, 적용/실패/보류 수, 마지막 진전 시각을 snapshot에 노출한다.
- [ ] 원문/번역/구조 경계의 민감한 본문 전체를 기본 로그에 남기지 않는다.
- [ ] 사용자용 오류는 provider 실패, 구조 검증 실패, DOM 적용 실패, 본문 없음, stale 문서로 구분한다.
- [ ] 개발자 모드에서 최근 tool call/result, validation summary와 적용 ack를 볼 수 있게 한다.
- [ ] 멈춤 감지 시 “재시도”, “실패 단위 건너뛰기”, “진단 내보내기”를 제공한다.
- [ ] 로그와 진단 export에서 API key와 원문 민감 정보를 제거한다.
- [x] 페이지 기본 진행 표시는 tool/turn 이름을 숨기고 번역 중, 확인 중, 일시정지, 부분 실패와 재시도 방법을 일반 사용자 문구로 구분한다.
- [x] 페이지 강조는 큰 주황색 블록 대신 얇은 강조선과 상태별 인라인 칩을 사용하며 reduced-motion을 존중한다.

### I. 캐시, 개인정보와 비용

- [ ] 캐시 key에 canonical URL, source hash, target language, provider/model, prompt/schema version을 포함한다.
- [ ] 변경된 단위만 무효화하고 동일한 원문 단위는 재사용한다.
- [ ] 사이트별/전체 캐시 삭제와 저장 기간/용량 제한을 제공한다.
- [ ] 인증 페이지, 로컬 파일, private browsing과 민감 사이트의 기본 저장 정책을 정한다.
- [ ] 전체 문서 번역과 detached 번역 전에 예상 호출 수와 비용 경고를 선택적으로 제공한다.
- [ ] 중복 시작, 새로고침, 여러 탭에서 같은 문서를 열었을 때 중복 결제를 막는 deduplication을 설계한다.

### J. 테스트와 릴리스

- [x] actor의 document resource, history, scheduler를 독립 단위 테스트한다.
- [ ] coverage/run/display policy 조합을 상태 전이 테스트로 고정한다.
- [ ] 탭 숨김, 탭 종료, 재연결, 새로고침, SPA navigation을 브라우저 통합 테스트한다.
- [ ] 본문 탐색 실패 사이트와 공백/줄바꿈 회귀 fixture를 유지한다.
- [ ] 실제 OpenAI-compatible endpoint로 tool stream delta, step limit, timeout과 continuation smoke test를 둔다.
- [ ] 실제 페이지 smoke test는 사용자 API key를 저장하거나 로그에 출력하지 않게 한다.
- [ ] Firefox Manifest V2의 background lifecycle과 AMO source build를 릴리스마다 확인한다.
- [ ] `pnpm test`, `pnpm compile`, `pnpm build:firefox`, 재현 가능한 AMO source build를 release gate로 둔다.

## 선행 리팩터 목표

새 옵션을 구현하기 전에 다음 경계를 만든다.

```text
Popup / commands
       |
Background session registry
       |-- DocumentResource (canonical source/translation/state)
       |-- AgentHistory (append-only, compactable)
       |-- WorkScheduler (leases, pause/resume, continuation)
       `-- LiveAttachment? (tabId + content client, 없어도 될 수 있음)
                         |
Content script
       |-- UnitCatalog / extraction
       |-- DOM patch plan
       `-- DisplayController (original/translated)
```

### 이번 리팩터 범위

- [x] 요구사항과 상태 의미를 이 문서에 먼저 고정한다.
- [x] `PageAgentActor`의 mutable document map과 unit 상태 전이를 `PageAgentDocumentResource`로 추출한다.
- [x] actor는 agent history와 turn orchestration을 담당하고 document 내부 Map을 직접 수정하지 않게 한다.
- [x] 추출된 document resource의 source 변경, lease, 번역, snapshot 동작을 독립 테스트한다.
- [x] lease, turn별 attempted unit과 DOM 적용 single-flight 상태를 `PageAgentWorkScheduler`로 추출한다.
- [x] 원문/번역 표시 의도를 agent job 상태를 모르는 `TranslationDisplayController`로 추출한다.
- [x] 기존 기본 동작(`reading-window` + `while-tab-open`)이 바뀌지 않았음을 전체 테스트/빌드로 확인한다.
- [ ] popup 진단 계기판 정리는 이번 범위에서 제외한다. 별도 popup UX 작업으로 다룬다.
- [x] 페이지 오버레이에서 모델 원문, step과 tool 이름을 숨기고 사용자 행동 중심의 상태 문구만 표시한다.

### Phase 0 경계 분리에서 하지 않은 것

- 새 옵션 UI 또는 설정 저장
- 전체 문서 번역
- visibility 기반 pause/resume
- 탭 종료 후 detached 실행/캐시
- 번역 영역 선택 inspector (Phase 1에서 기본 선택 흐름 구현)
- 원문 보기 UX 변경
- 공백/줄바꿈 계약 변경
- 새로운 모델 prompt나 few-shot 변경

### 중단/재개 안전성

- [ ] popup의 진행 중 작업 버튼을 hard cancel인 “Stop”에서 turn-boundary “Pause”로 바꾸는 UI 작업은 별도 범위로 둔다.
- [x] pause와 resume가 같은 actor, session id, document resource를 유지하게 한다.
- [x] pause 이후 진행 중인 한 provider turn의 유효 결과는 적용하되 다음 turn은 시작하지 않는다.
- [x] pause 중 새로 관측한 단위는 document resource에 추가하되 모델에 lease하지 않는다.
- [x] resume 시 pending, 신규 또는 source/structural boundary가 변경된 단위만 처리한다.
- [x] 이미 applied인 동일 source 단위는 설정 동기화나 재개 때문에 다시 번역하지 않는다.
- [x] 완료된 세션에서 다시 확인할 때 동일 단위는 보존하고 새 단위만 현재 runner로 번역한다.
- [x] 명시적 cancel은 in-flight 호출 중단과 stale apply 차단 용도로 별도 유지한다.
- [x] actor, manager, content, popup 라우팅과 버튼 상태를 회귀 테스트한다.

## 구현 순서

1. **Phase 0 — 경계 분리**
   - 완료: document resource, work scheduler, display controller, session registry와 live attachment 추출
   - 완료: document/job identity와 tab id 분리, 현재 `while-tab-open` 탭 종료 회귀 테스트
2. **Phase 1 — 정확성 및 진단**
   - 구조/공백 회귀 fixture
   - 진행: 강제 영역 선택 기본 흐름, 자동 결과와 병합, 안전 제외 및 offscreen 회귀 테스트
   - 다음: 큰 영역 확인, 선택 해제, 본문 탐색 실패 제안과 진단
   - agent stall/tool stream 오류 상태와 관측성
3. **Phase 2 — 로컬 정책**
   - 완료: 수동 pause/resume과 hard cancel/discard 의미 분리
   - 완료: `reading-window`/`full-document` coverage policy, 저장, 설정 화면의 사용자용 단일 선택 UI
   - 완료: `while-visible`/`while-tab-open` 저장, 설정 화면의 사용자용 단일 선택 UI와 visibility 기반 turn-boundary pause/resume
   - 다음: `continue-after-close`를 노출하기 전 detached 결과 보관 및 재연결
   - display mode와 lifecycle policy 설정 UI
4. **Phase 3 — detached 작업**
   - document identity/fingerprint
   - tab attachment 분리
   - 탭 종료 후 계속, 캐시, 재연결
5. **Phase 4 — 재시작 복구와 고급 UX**
   - 브라우저 재시작 후 scheduler 복구
   - 사이트별 선택 root, bilingual/hover 원문, 비용 제어

## 완료 기준

- 옵션 이름만 보고도 번역 범위, 실행 수명, 표시 모드와 작업 제어가 혼동되지 않는다.
- 탭 종료 후 진행은 DOM 적용이 아니라 detached 번역과 안전한 재연결이라는 점이 코드와 UI에 반영된다.
- 원문 보기가 실행 중인 agent session을 취소, 재시작 또는 중복 호출하지 않는다.
- document resource는 chat compaction과 무관하게 원문, placeholder, 번역문과 unit 상태를 보존한다.
- 모든 번역 결과는 tool submission → runtime validation → content apply ack 경로만 통과한다.
- 자동 본문 탐색에 실패해도 사용자가 영역을 강제로 추가할 수 있다.
- 공백과 줄바꿈은 escape 문자열 후처리가 아니라 구조 계약으로 보존된다.
- 회귀 테스트와 Firefox 빌드가 통과한다.
