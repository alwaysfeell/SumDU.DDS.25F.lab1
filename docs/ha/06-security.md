# Security-аналіз обраного рішення

## Нові поверхні атак

| Компонент / порт | Загроза | Захист |
| --- | --- | --- |
| Patroni REST API :8008 | POST/PATCH дозволяють switchover, restart, reinitialize, зміну конфігурації кластера | `restapi.authentication`, TLS (`certfile`, `keyfile`), `allowlist` з адресами app-Droplet, порт лише у VPC |
| etcd :2379 (клієнти), :2380 (peer) | запис у ключі Patroni = захоплення лідерства або зміна конфігурації; читання розкриває топологію | mTLS для клієнтів і peer, `--client-cert-auth`, RBAC-користувач для Patroni, DO Cloud Firewall: лише 3 вузли БД |
| PostgreSQL :5432 на 3 вузлах | більше точок входу, ніж один контейнер; репліки містять усі дані | `hostssl` + scram-sha-256 у pg_hba (керує Patroni), доступ лише з app-Droplet і між вузлами БД |
| HAProxy :5000/:5001, stats | доступ в обхід застосунку, витік стану кластера | bind на 127.0.0.1 (sidecar), stats вимкнено або лише на localhost |
| pgBackRest + Spaces | крадіжка бекапів = крадіжка всієї БД | `repo1-cipher-type=aes-256-cbc`, окремий ключ доступу лише до бакета, приватний бакет |
| Агенти Grafana Alloy, Grafana Cloud | токен запису метрик, витік метрик і топології | окремий токен лише на запис, обмежений scope, без даних користувачів у мітках |
| healthchecks.io, Telegram-бот | підробка або блокування сповіщень | секретні URL пінгів і токени в secret manager |
| SSH до Droplet, watchdog | керування вузлом = керування кластером | SSH лише за ключами, через VPN або обмежений firewall, sudo з аудитом |

## Захист взаємодії

- усі Droplet у приватній VPC, назовні відкритий лише Load Balancer :443;
- DigitalOcean Cloud Firewall: app → 5432/8008 вузлів БД; БД ↔ БД 5432, 8008, 2379, 2380; вихідний трафік агентів моніторингу — лише на Grafana Cloud;
- TLS для PostgreSQL (`ssl=on`, `hostssl`), mTLS для etcd, HTTPS для Patroni REST API;
- реплікація лише окремим користувачем з атрибутом REPLICATION, як у лабораторній роботі №4;
- застосунок підключається користувачем без SUPERUSER, для read-пулу можна окремого користувача лише з SELECT.

## Секрети

| Секрет | Де використовується | Як зберігати |
| --- | --- | --- |
| Пароль superuser PostgreSQL | Patroni (керування) | secret manager, не в git |
| Пароль користувача реплікації | Patroni, репліки | secret manager |
| Пароль користувача pg_rewind | Patroni | secret manager |
| Паролі app_user / app_reader | TravelerAPI | secret manager / Docker secret |
| Логін і пароль Patroni REST API | patronictl, адміністратор | secret manager |
| Сертифікати й ключі etcd, Patroni, PostgreSQL | mTLS / TLS | файли 0600 на вузлах, ротація |
| Ключі Spaces і `repo1-cipher-pass` | pgBackRest | secret manager, окремий обмежений ключ |
| Токен Grafana Cloud, URL healthchecks.io, токен Telegram-бота | моніторинг | secret manager |

## Зберігання конфігурації

- patroni.yml, haproxy.cfg, конфігурація etcd і агентів — у git як шаблони без секретів, за аналогією з `.env.example`;
- секрети підставляються під час розгортання з Vault, SOPS + age або secret manager провайдера;
- зміни через pull request з рев'ю; динамічна конфігурація кластера — лише через `patronictl edit-config`;
- права на файли конфігурації 0600, власник — службовий користувач;
- знімки etcd зберігаються зашифрованими.

## Рекомендації

1. Увімкнути TLS/mTLS на всіх каналах кластера до запуску в production.
2. Закрити REST API Patroni паролем і allowlist, etcd — клієнтськими сертифікатами.
3. Перенести секрети з `.env` у secret manager і налаштувати ротацію.
4. Шифрувати бекапи і щомісяця перевіряти відновлення.
5. Обмежити SSH (ключі, VPN, MFA) і вести аудит дій адміністратора.
6. Стежити за CVE PostgreSQL, Patroni, etcd, HAProxy і оновлювати їх rolling update по одному вузлу.
7. Налаштувати алерти на зміну лідера, зміну конфігурації кластера та невдалі спроби автентифікації.
