FROM alpine:3.22
RUN apk add --no-cache postgresql17-client rclone bash tzdata curl openssl
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
CMD ["/usr/local/bin/backup.sh"]
