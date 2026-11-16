/**
 * Сеть в контейнере: IPv6 наружу нет. По умолчанию Node пробует адреса по очереди и через 250 мс
 * бросает медленный IPv4 ради IPv6 - до серверов Telegram соединение иногда дольше, и запрос
 * падал с ETIMEDOUT (например, скачивание фото чека для админки). Берём IPv4 и ждём его сколько нужно.
 * Импортируется первым в точках входа.
 */
import dns from 'node:dns';
import net from 'node:net';

dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamily(false);
