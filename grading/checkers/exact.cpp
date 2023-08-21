#include <cstdio>

char x, y;

int main(int argc, char *argv[]) {
    if (argc < 3) return printf("FL"), 0;
    FILE *ans = fopen(argv[1], "rb");
    FILE *out = fopen(argv[2], "rb");
    while (~fscanf(ans, "%c", %x)) {
        if (!x) break;
        if (!~fscanf(out, "%c", &y)) return printf("WA"), fprintf(stderr, "End of out"), 0;
        if (x != y) return printf("WA"), fprintf(stderr, "Differ"), 0;
    }
    if (~fscanf(out, "%c", &y) && y) return printf("WA"), fprintf(stderr, "End of ans"), 0;
    printf("AC");
}