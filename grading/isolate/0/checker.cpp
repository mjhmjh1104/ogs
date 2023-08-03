#include <cstdio>
#include <cstring>

char x[257], y[257];

int main(int argc, char *argv[]) {
    if (argc < 3) return printf("FL"), 0;
    FILE *ans = fopen(argv[1], "rb");
    FILE *out = fopen(argv[2], "rb");
    while (~fscanf(ans, "%256s", x)) {
        if (!*x) break;
        if (!~fscanf(out, "%256s", y)) return printf("WA"), fprintf(stderr, "End of out"), 0;
        if (strcmp(x, y)) return printf("WA"), fprintf(stderr, "Differ"), 0;
    }
    if (~fscanf(out, "%256s", y) && *y) return printf("WA"), fprintf(stderr, "End of ans"), 0;
    printf("AC");
}