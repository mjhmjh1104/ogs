#!/bin/sh

if [ $# -lt 2 ]; then
    echo 'Not enough params' >&2
    exit 1
else
    g++ ${@:2} -o $1 -Wall -std=gnu++2a -O2 -DONLINE_JUDGE -DOGS
fi