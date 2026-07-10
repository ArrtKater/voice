# VoiceChat — деплой на VPS (voice.artkater.online)

## 1. Залить на сервер
    scp -r voicechat root@80.78.245.232:/opt/
    cd /opt/voicechat && npm install ws selfsigned

## 2. Сертификат (когда DNS обновится)
    apt install -y nginx certbot python3-certbot-nginx
    certbot certonly --nginx -d voice.artkater.online

## 3. nginx
    cp deploy/voicechat.nginx.conf /etc/nginx/sites-available/voicechat
    ln -s /etc/nginx/sites-available/voicechat /etc/nginx/sites-enabled/
    nginx -t && systemctl reload nginx

## 4. Автозапуск
    chown -R www-data:www-data /opt/voicechat
    cp deploy/voicechat.service /etc/systemd/system/
    systemctl daemon-reload && systemctl enable --now voicechat
    systemctl status voicechat

## Готово
https://voice.artkater.online — имя + пароль zhopa.

## Админка
В чате: /admin superzhopa42 (пароль поменяй в server.js, константа ADMIN_PASS).
Далее /help — список команд, /ghost — невидимка.

## Режимы
- VPS (по умолчанию): node server.js — HTTP на 127.0.0.1:8443, TLS делает nginx
- LAN/Radmin:          node server.js --tls — HTTPS с самоподписанным сертификатом

## Если у кого-то не слышно голос (строгий NAT/мобильный интернет)
Нужен TURN: apt install coturn, в /etc/turnserver.conf:
    listening-port=3478
    realm=voice.artkater.online
    user=voicechat:СЛОЖНЫЙ_ПАРОЛЬ
    lt-cred-mech
    fingerprint
Открыть порты 3478 tcp/udp и 49152-65535 udp, systemctl enable --now coturn.
Затем в public/index.html раскомментировать строку turn: в rtcCfg.
