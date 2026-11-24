# Дослідження рішень через LLM
 
Промпт: [03-llm-prompt.md](03-llm-prompt.md). Кожна модель отримала однаковий промпт у новому чаті без попереднього контексту (Claude — на окремому акаунті без проєктів і пам'яті).
 
| LLM | Модель / версія | Дата | Повідомлень | Публічне посилання на чат |
| --- | --- | --- | --- | --- |
| ChatGPT (OpenAI) | GPT-5.6 Luna, безкоштовний тариф | 24.11.2026 | 9 | https://chatgpt.com/share/6b05ac23-d2bc-83ed-8df0-e6db09c40676 |
| Gemini (Google) | Gemini 4 Hydrogen, рівень міркувань «Високий» | 24.11.2026 | 6 | https://gemini.google.com/share/13041a1a89fe |
| Claude (Anthropic) | Claude Sonnet 5.5, Medium, безкоштовний тариф | 24.11.2026 | 4 (ліміт free) | https://claude.ai/share/441a2100-17c4-4147-9806-cf1849f6d822 |
 
## ChatGPT
 
**Запропоновані рішення:**
 
- ручний failover стандартними засобами PostgreSQL — відхилено самою LLM через RTO;
- Patroni + etcd (3 учасники) + HAProxy — основна рекомендація;
- керований PostgreSQL (RDS, Cloud SQL, Azure, Aiven) — альтернатива з вищою ціною;
- repmgr — згадано в таблиці порівняння.
**Рекомендація:** 3 DB VM (PostgreSQL 18 + Patroni + etcd, 1 sync + 1 async репліка, `synchronous_mode_strict: true`), 2 API VM з HAProxy як sidecar, окремі READ/WRITE пули, хмарний Load Balancer, pgBackRest в Object Storage, Prometheus + Grafana + Alertmanager. Бюджет за цінами Hetzner ≈ 101–117/міс.
 
**Red Teaming:**
 
| Запитання | Відповідь LLM (коротко) | Оцінка |
| --- | --- | --- |
| Розрив зв'язку на 20 с: чи будуть два master? | Розібрала два випадки: при розриві лише між PG лідер не змінюється; при втраті etcd старий primary понижується після retry_timeout до спливання ttl. Згадала fencing | правильно |
| Час відновлення при раптовому вимкненні VM з primary | ttl 30 + цикл + promote + HAProxy ≈ 37–47 с, вкладаємося у 2 хв; для падіння лише PG — loop_wait + primary_start_timeout + loop_wait = 40 с | правильно |
| Ціна CX23 5.49 чи 6.49? | Визнала, що змішала євро і долари | визнала помилку |
| Stateless API і read-after-write, застаріла version з репліки | Повертати ресурс у відповіді PUT, `?consistency=strong`, ETag/If-Match; стара version дасть 409 на primary, без втрати даних | правильно |
| db2 недоступна 20 с — чи блокуються записи весь час? | Визнала, що помилилась: Patroni призначить синхронною db3 за 1–7 с; при «blackhole» обрив виявляється через wal_sender_timeout (60 с) | визнала помилку |
| psycopg_pool не відновився після повернення primary | `check=ConnectionPool.check_connection`, reconnect_timeout, розділити /health на live і ready | правильно, збігається з експериментом |
| Хто стежить за HAProxy, LB і моніторингом на APP-2? | Визнала SPOF моніторингу, запропонувала зовнішній uptime-monitor | визнала проблему |
| Fallback читання: FastAPI чи backup-сервер у HAProxy? | HAProxy простіше; кожен вузол двічі — з /replica і з /primary як backup | правильно |
| Поглиблене дослідження Patroni (2.4) | Покроковий failover, 4 групи параметрів, 8 edge cases; Patroni 4.1.5 (12.08.2026), PG 9.3–18; радить `failsafe_mode: false` на старті | правильно |
 
**Проблеми та галюцинації:** неузгоджена ціна CX23 між відповідями (євро/долари); твердження, що CX23 недоступний для замовлення, не перевірено; спочатку стверджувала, що записи блокуються на весь час недоступності sync-репліки; не порахувала сценарій вимкнення всієї VM, поки не спитали; моніторинг на одному з API-вузлів. PgCat/PgBouncer як HA не пропонувала.
 
## Gemini
 
**Запропоновані рішення:**
 
- Patroni + etcd/Consul з watchdog — основна рекомендація;
- pg_auto_failover або repmgr з witness — простіші, але слабший захист;
- керовані DBaaS (RDS Multi-AZ, Cloud SQL, DigitalOcean Managed PG);
- маршрутизація: HAProxy + REST API Patroni, libpq multi-host (`target_session_attrs`), Floating IP / DNS.
**Рекомендація:** 3 VM, на кожній PostgreSQL + Patroni + etcd; HAProxy і web на VM-1 і VM-2, моніторинг і pgBackRest на VM-3; кворумна реплікація `ANY 1 (pg2, pg3)`, HAProxy з backup на primary для читання, `max_slot_wal_keep_size`, `hot_standby_feedback`. Бюджет 55–145 /міс залежно від провайдера.
 
**Red Teaming:**
 
| Запитання | Відповідь LLM (коротко) | Оцінка |
| --- | --- | --- |
| Розрив зв'язку на 20 с: чи будуть два master? | Таблиця таймінгів: demote через retry_timeout, потім спливання ttl, promote; окремо частковий розрив без failover; три рівні захисту (sync, etcd, watchdog) | правильно (для некоректних параметрів) |
| Чи відповідають ttl 10, loop_wait 2, retry_timeout 5 правилам Patroni? | Визнала: ttl менше мінімуму 20 і 10 < 2 + 2·5; виправила на ttl 20, RTO 21–28 с | визнала помилку |
| Хто керує `ANY 1 (pg2, pg3)` під Patroni? | Параметр не задається вручну, Patroni веде /sync і обирає кандидата за LSN; але `synchronous_mode: true` назвала таким, що дає `ANY 1` | частково помилилась |
| Різниця `synchronous_mode: true` і `quorum` | Визнала змішування режимів; true = FIRST, quorum = ANY; для TravelerAPI рекомендує quorum | визнала помилку |
| Моніторинг на VM-3 і хто стежить за HAProxy та LB | Визнала fate-sharing, запропонувала зовнішній Dead Man's Switch, ланцюжок «хто за ким стежить» | визнала проблему |
| Поглиблене дослідження Patroni (2.4) | Покроковий run_cycle, параметри, edge cases (watchdog у Docker, pg_rewind після crash, flapping); 4.1.5 від 12.08.2026, PG 18 підтримується | загалом правильно |
 
**Проблеми та галюцинації:** параметри Patroni порушували правило і мінімум ttl (виправлено після запитання); `synchronous_mode: true` описано як кворумний режим; quorum-режим датовано Patroni 3.0, хоча він з'явився в 4.0 (серпень 2024); твердження, що розробку веде Zalando, застаріле — проєкт з 2024 року в організації patroni/patroni; «новий параметр output_plugin_libraries» у PostgreSQL 18.6 не підтверджено; моніторинг і бекапи на вузлі з реплікою. PgCat/PgBouncer як HA не пропонувала.
 
## Claude
 
**Запропоновані рішення:**
 
- Patroni + etcd — де-факто стандарт self-managed HA;
- repmgr (witness, слабший захист від split-brain), pg_auto_failover (монітор — SPOF);
- Kubernetes-оператори, Pacemaker/Corosync + PAF — надмірна складність для однієї людини;
- керовані БД з Multi-AZ;
- маршрутизація: HAProxy + Patroni REST (`/primary`, `/replica?lag=`, `/read-only`), libpq multi-host, VIP/DNS.
**Рекомендація:** Patroni + etcd + HAProxy + pgBackRest; 3 DB VM, 2 API VM з HAProxy sidecar, балансувальник, окрема мала VM для моніторингу або Grafana Cloud; `synchronous_mode: quorum` (Patroni 4.x), фільтр lag для читання, psycopg_pool з `check`. Бюджет на DigitalOcean: 137 (з VM моніторингу) або 125 (без неї).
 
**Red Teaming:**
 
| Запитання | Відповідь LLM (коротко) | Оцінка |
| --- | --- | --- |
| Розрив зв'язку на 20 с: чи будуть два master? | Два випадки; три бар'єри (правило таймінгів, quorum sync, watchdog); застереження про локально видиму непідтверджену транзакцію на ізольованому primary | правильно, найповніше |
| Падіння лише PostgreSQL при живому Patroni | Визнала, що 15–40 с тут не застосовне: `primary_start_timeout` = 300 с порушує RTO, радить 30–60 с | визнала помилку |
| Хто стежить за HAProxy, LB, моніторингом; бюджет на DO | /readyz через HAProxy, зовнішній dead man's switch; бюджет 137 / 125 за прайсом DO; ризик shared CPU для Patroni | правильно, виправила попередню оцінку 50–90 |
| Поглиблене дослідження Patroni (2.4) | Покроковий failover, параметри з історією версій, edge cases з release notes; 4.1.5 від 12.08.2026, сумісність із PG 18.6; неточність lag-фільтра /replica | правильно |
 
**Проблеми та галюцинації:** початкова оцінка бюджету 50–90 занижена (виправлена); RTO 15–40 с наведено без урахування `primary_start_timeout` (виправлено); мінімальний loop_wait названо 2, хоча за документацією мінімум 1. PgCat/PgBouncer як HA не пропонувала. Через ліміт безкоштовного тарифу вдалося поставити лише 4 повідомлення.
 
## Порівняння LLM
 
| Критерій | ChatGPT | Gemini | Claude |
| --- | --- | --- | --- |
| Головна рекомендація | Patroni + etcd + HAProxy, 3 DB + 2 API | Patroni + etcd + HAProxy, 3 VM спільного призначення | Patroni + etcd + HAProxy + pgBackRest, 3 DB + 2 API |
| Помітила пастку `FIRST 1` з однією реплікою | так | так | так |
| Помітила, що репліка не обслуговує читання | так | так | так |
| Сама помітила проблему пулу з'єднань | ні (після запитання) | ні | так |
| Кворумна реплікація | ні | так, але з помилкою режиму | так, коректно |
| Split-brain на 20 с | правильно | правильно | правильно, найповніше |
| Скільки разів визнала помилку | 3 | 3 | 2 |
| `failsafe_mode` | false | true | true |
| PgCat / PgBouncer як HA | ні | ні | ні |
 
## Червоні прапорці, за якими перевірялись відповіді
 
| Порада LLM | Чому це помилка |
| --- | --- |
| PgCat / PgBouncer як основне HA-рішення | це пулери й маршрутизатори з'єднань: вони не виявляють відмову надійно і не виконують pg_promote |
| etcd / Consul з 2 вузлів | кворум 2 з 2 не переживає відмову жодного вузла |
| keepalived з VIP як повний захист | без сховища консенсусу і fencing при розриві мережі можливі два primary |
| recovery.conf, trigger_file, promote_trigger_file | recovery.conf прибрано в PostgreSQL 12, promote_trigger_file — у PostgreSQL 16 |
| md5 для паролів | у PostgreSQL 18 md5 оголошено застарілим |
| ttl < 20 або loop_wait + 2·retry_timeout > ttl | порушення правил Patroni (знайдено у Gemini) |
| `synchronous_mode: true` = `ANY 1` | це кворумний режим `synchronous_mode: quorum`, з'явився в Patroni 4.0 (знайдено у Gemini) |
| Параметри з «master» (master_start_timeout, /master) | у сучасних версіях Patroni — primary_start_timeout, /primary |
 