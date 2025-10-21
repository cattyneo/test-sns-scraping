# SNSフォロワー数取得 PoC（Laravel）—機能概要書

## 1) ゴール / 非ゴール

**ゴール**

* X・TikTok・Instagram・YouTube の指定IDから「フォロワー数/登録者数」を**あらゆる手段**（公式API / スクレイピング / Playwright / Apify）で取得し、**取得可能性・正確性・速度・コスト・運用性**を比較評価する。
* 画面でIDやパラメータを入力→実行→結果と所要時間を可視化。履歴管理と再実行ができる。
* 取得ロジックは**サービス層**に集約し、他アプリから再利用できる形で提供。

**非ゴール**

* 長期運用の本番SLA達成。／BAN回避の保証。／詳細なレポート生成

---

## 2) 対象プラットフォームと取得手段の方針

対象: **X / TikTok / Instagram / YouTube**

**評価軸**: ①成功率 ②正確性 ③速度 ④コスト

**試行モード**

* **全手段試行**: 公式API → Apify → Playwright → スクレイピング を**すべて**実行して記録
* **成功で停止**: 優先度順に試行し、最初の成功で打ち切り

**優先度**

1. 公式API（利用可能の場合）
2. Apify
3. Playwright
4. 直接スクレイピング

---

## 3) 画面（管理UI）要件（Filament v4想定）

### 入力フォーム

* **プラットフォーム**: X / TikTok / Instagram / YouTube（複数選択可）
* **対象ID**: 1行=1ID（複数行ペースト対応）。X=ユーザー名 or 数値ID、IG=ユーザー名/IG User ID、TikTok=ユーザー名、YouTube=チャンネルID/ハンドル/カスタムURL
* **試行モード**: 全手段試行 / 成功で停止
* **実行パラメータ**（任意）:

  * タイムアウト(ms) / リトライ回数
  * **User-Agent/Accept-Language/Viewport**（プリセット or カスタム）
  * **ヘッドレス**（ON/OFF）/ スロットリング（ネットワーク/CPU）
  * **プロキシ**（HTTP(S)/SOCKS）
  * **待機戦略**（固定/指数バックオフ/人間風ランダム）
* 実行ボタン: `取得を実行`

> 実行パラメータは適切な初期値を設定しつつ、ユーザーが任意に指定可能とする。指定値は保存される。

### 結果表示パネル

* **最新実行の集計**: 成功件数/失敗件数、平均所要時間、メソッド別成功率
* **直近結果**（カード）: ID / プラットフォーム / 取得値 / 小数点・丸め情報 / **ソース（公式API/Playwright/…）** / 所要時間 / 実行時刻
* **詳細モーダル**: 生レスポンス(JSON), スクリーンショット(Playwright), HTTPトレース, ログ

### 取得履歴テーブル

* 列: 実行ID, プラットフォーム, 対象ID, **メソッド**, 取得値, ステータス, 所要時間, 実行者, 実行時刻
* フィルタ: 期間/プラットフォーム/メソッド/ステータス/ID, キーワード検索
* 行クリック→**実行詳細**（ログ/アーティファクト参照）

---

## 4) アプリ構成（再利用可能なサービス分離）

```
Presentation(Filament)
  └ UseCase / Controller
      └ Orchestrator  … 試行モードに応じてメソッドを並列/直列に実行
          ├ PlatformService[X|IG|TT|YT]  … 各プラットフォームのファサード
          │   ├ OfficialApiService
          │   ├ ScrapingService (HTTP/パーサ)
          │   ├ PlaywrightService (Node呼び出し)
          │   └ ApifyService
          └ ResultAggregator … 値の正規化・整合性検証
Infra
  ├ HTTP Client(Guzzle), Cache(Redis), Queue(Horizon)
  ├ Playwright Runner(Nodeサイドカー or コンテナ)
  └ Storage(S3/GCS)  … スクショ/トレース保存
Domain
  ├ DTO: FetchRequest, FetchResult, AttemptLog
  └ VO: FollowerCount (value=int, visible=bool, rounding=enum)
```

**オーケストレーター仕様**

* 実行単位: (プラットフォーム×ID)
* 手段ごとに**並列**（タイムアウト短縮）または**優先度順直列**を選択
* それぞれ**Attempt**として開始/終了/例外を記録（ミリ秒計測）
* 正常値判定→**Result**集約（丸め/秘匿設定/非公開時の扱い）

**再利用性**

* `PlatformServiceInterface::fetchFollowerCount(TargetId, Options): FetchResult`
* 外部アプリは上記IFの**DI**経由で利用可

---

## 5) データモデル（ER 概要）

* **social_targets**: id, platform(enum: x/ig/tt/yt), handle_or_numeric_id, meta(json: 種別/可視設定), created_by
* **retrieval_runs**: id, mode(enum: all/first_success), requested_by, params(json), started_at, finished_at
* **retrieval_attempts**: id, run_id, target_id, method(enum: official/scraping/playwright/apify), status(enum: success/fail/timeout), duration_ms, http_status, error_code, artifact_ids(json)
* **retrieval_results**: id, run_id, target_id, source_method, follower_count(int|null), visible(bool), rounding(enum: exact/rounded/hidden), raw(json), dedup_hash
* **artifacts**: id, type(enum: screenshot/har/log), path, size, sha256
* **metrics_daily**: method別成功率/平均時間/コスト概算

インデックス: `(platform, handle_or_numeric_id) UNIQUE`, `retrieval_attempts(run_id)`, `retrieval_results(target_id, run_id)`

---

## 6) 実行フロー（シーケンス）

1. 画面入力 → Run生成（mode/params）
2. ターゲットIDを展開→Queue投入（1ジョブ=1ターゲット）
3. **Orchestrator**が手段N個を実行

   * 公式API → 失敗なら次手段へ
   * スクレイピング（静的HTML/JSONエンドポイント）
   * Playwright（レンダリング, ログイン対応オプション）
   * Apify Actor 起動→Dataset取得
4. 各**Attempt**を記録、ResultAggregatorで**結果決定**

   * 値の突合（差が大きい場合は**警告**、ルール例: 最大/最小差が±3%超で警告）
5. 画面に即時反映（Livewireイベント）

> バックグラウンド実行→ジョブ管理UIで実行中/完了/失敗を表示→結果を画面に表示
> 開始後にモーダル等を表示せず、次の操作を可能にする

---

## 7) 取得手段別の注意点（プラットフォーム別）

### X（旧Twitter）

* 公式API: `users/by|users/:id` + `user.fields=public_metrics`（followers_count 取得可）
* スクレイピング: WebのGraphQL/REST内部API（仕様非公開・変動）
* Playwright: 非ログイン/ログイン双方検証。カウント表示の**略記（1.2M）**は数値化処理が必要
* Apify: Xユーザ情報系アクターを利用（入出力スキーマは保存）

### Instagram（Meta IG Graph）

* **Graph API**で**Business/Creator**アカウントの`followers_count`取得可。
* **Basic Display API**はフォロワー数を返さない（要注意）。
* 他アカウントの取得は**Business Discovery**対象に限定・制約多い。
* 非公開/個人アカウントは取得不可が基本。

### TikTok

* 公式API（v2 User Info等）は**ユーザー認可トークン**が前提。公開アカウントのフォロワー数を**無認可で直接取得できない**可能性が高い。
* **Research API**は学術向け枠で要申請。Followersリスト取得は可だが一般アプリでは不可の前提で評価。
* Playwright/スクレイピングでページ内JSON/内部APIから取得するアプローチは可能性ありだが**検出/ブロック**に注意。

### YouTube

* **YouTube Data API v3** `channels.list(part=statistics)` → `statistics.subscriberCount`（非公開の場合は取得不可）。表示は**丸め・非公開**仕様あり。

### 共通（スクレイピング）

* 直リンクHTML/内部API(JSON)の**探索→抽出**。selectorsは**バージョン別**に保持。
* **頻繁なDOM変更**・**略記表記**・**i18n**（「万」「M」）に対応。

### 共通（Playwright）

* **人間らしさ**: ランダムUA/言語/ビューポート、`scroll`, `hover`, `delay`、ヘッド**有り**実行、ステップ間待機。
* **アーティファクト**: スクリーンショット/コンソールログ/ネットワークHAR保存。

### 共通（Apify）

* 既存アクターを**同期/非同期**で起動→**Dataset**参照。レート・課金の管理を実装側で吸収。

- Apify Actor一覧
    - X: https://apify.com/kaitoeasyapi/premium-x-follower-scraper-following-data
    - X:https://apify.com/curious_coder/twitter-scraper
    - IG: https://apify.com/apify/instagram-profile-scraper
    - Tiktok: https://apify.com/clockworks/tiktok-scraper
    - Tiktok: https://apify.com/clockworks/tiktok-profile-scraper
    - Youtube: https://apify.com/streamers/youtube-scraper

---

## 8) 「人間らしさ」実装ポリシー

* **User-Agent回転**: 最新ブラウザ群/モバイル混在のプリセットプール
* **Accept-Language**: `ja,en-US,en`の優先度調整
* **Viewport/Device**: デスクトップ/モバイルをランダム選択（Playwright devices）
* **待機**: 50–400msの**揺らぎ**を各操作間に挿入
* **入力**: タイピング速度・スクロール量にランダム性
* **ネットワーク**: 正常/3G Slow等のスロットリングをランダム適用（検知回避）

> ブロック検知時は**即停止**しクールダウン

---

## 9) 設定（.env想定）

```
# X
X_BEARER_TOKEN=

# Instagram Graph（Business/Creator）
IG_APP_ID=
IG_APP_SECRET=
IG_REDIRECT_URI=
IG_ACCESS_TOKEN=
IG_IG_USER_ID=   # 自社ビジネス/クリエイターID（Business Discoveryの起点）

# TikTok
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
TIKTOK_ACCESS_TOKEN=

# YouTube
YOUTUBE_API_KEY=

# Apify
APIFY_TOKEN=

# ネットワーク/実行
HTTP_PROXY=
PLAYWRIGHT_PROXY=
UA_POOL_PATH=storage/app/ua-pool.txt
FETCH_TIMEOUT_MS=12000
FETCH_RETRY=2
```

---

## 10) ログ/メトリクス/可観測性

* **構造化ログ**（attempt_id/target/method/duration_ms/http/err）
* **メトリクス**: method別 成功率/平均時間/エラー率/429発生率
* **アラート**: 連続失敗, レート超過, DOM変更検知（選択子ミスマッチ）
* **アーティファクト**: スクショ/HAR/Raw JSONを **run_id/attempt_id** で保存

---

## 11) セキュリティ / 法務

* **トークンは.env + Secrets**（Vault/GCP Secret Manager推奨）
* **最小権限**: 読み取り専用スコープのみ
* スクレイピング/Playwrightは**過剰アクセス防止**・**CAPTCHA検知で停止**

---

## 12) リスク & 回避策

* **仕様変更**: セレクタ版管理 / ヘルスチェック / 失敗時は他手段へフォールバック
* **レート制限**: キューで拡散 / キャッシュTTL / バックオフ
* **非公開・丸め表示**: 値に`visible=false`や`rounding=rounded`を付与
* **アカウント制約**: IGはBusiness/Creator限定、TTは認可必須/研究APIなど前提確認
* **コスト**: Apify実行回数・Playwright並列度を**レートリミット**

---

## 13) マイルストーン

* **v0.1 PoC**: 1プラットフォーム×2手段（公式API/Playwright）で動作確認＋履歴保存
* **v0.2**: 全プラットフォーム×全手段、所要時間/成功率の自動集計
* **v0.3**: セレクタ版管理・監視・通知、外部アプリ用の**Facade/SDK**切り出し

---

## 14) 受け入れ基準（例）

* **Given** プラットフォーム=YouTube、チャンネルID=有効
  **When** 取得を実行
  **Then** `subscriberCount` が `retrieval_results` に保存され、画面に表示。所要時間が200ms以上の精度で計測される。
* **Given** IGの個人アカウント
  **When** 公式API取得
  **Then** `visible=false` か **取得不可**として記録、Playwright/Apifyが試行される。
* **Given** Xで略記(1.2M)
  **When** スクレイピング
  **Then** 値が**整数**に正規化され、`rounding=rounded`が付与される。

## 15) 制約事項
- メソッドや関数は、**必ず**context7 MCP で確認する
- 設定値やパラメータは、既定値を設定しつつ、ユーザーが任意に指定可能とする
- エラー発生時や失敗時は中断せず、次の処理へ進む。必要なパラメータが未設定の場合（APIキーなど）もエラーを表示