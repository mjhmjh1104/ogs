#!/bin/sh

cd isolate
sudo make install
cd ..

mkdir -p archive
mkdir -p grading/submissions
mkdir -p grading/compilers
mkdir -p grading/checkers
mkdir -p grading/messages
mkdir -p changelog

yes n | cp -i default_config.json config.json