#!/bin/sh

if [ $# -lt 2 ]; then
    echo 'Not enough params' >&2
    exit 1
else
    out="$1"
    shift
    g++ $@ -o $out -Wall -std=gnu++2a -O2 -DONLINE_JUDGE -DOGS
fi