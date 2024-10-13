#!/bin/sh

# This test database restore script is designed to be bind mounted inside mongo
# container at /usr/local/bin/initdb location, then called on started container as
# 'docker-compose exec mongo initdb'.

mongorestore --drop --gzip --db pastvu --archive=/pastvu.gz
