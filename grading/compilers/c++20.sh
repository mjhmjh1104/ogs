if [ $# -lt 2 ]; then
    echo 'ERROR NOT ENOUGH PARAMS'
    exit 1
else
    g++ $1 -o $2 -Wall -std=c++2a -O2 -DONLINE_JUDGE -DOGS
fi