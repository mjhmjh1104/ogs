#!/bin/sh

cd isolate
sudo make install
cd ..

mkdir -p archive

yes n | cp -i default_config.json config.json