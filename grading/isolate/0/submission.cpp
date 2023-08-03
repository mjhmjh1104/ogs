#include <tuple>
#include <cstdio>
#include <vector>
#include <cstdlib>
#include <algorithm>
using namespace std;

const int HEIGHT = 12;
const int WIDTH = 150;
const int MOD = (int)1e9 + 7;

int tmp[HEIGHT + 2], h, w, k;
char str[HEIGHT][WIDTH + 1];

struct Item {
    int x[HEIGHT + 1];
    int blue[HEIGHT];
    int dist, cnt;
    Item () {
        for (int i = 0; i < HEIGHT + 1; i++) x[i] = 0;
        for (int i = 0; i < HEIGHT; i++) blue[i] = false;
        dist = 0;
        cnt = 1;
    }
    void normalize() {
        int k = 0;
        for (int i = 0; i < HEIGHT + 2; i++) tmp[i] = 0;
        for (int i = 0; i < HEIGHT + 1; i++) if (x[i] && !tmp[x[i]]) tmp[x[i]] = ++k;
        for (int i = 0; i < HEIGHT + 1; i++) if (x[i]) x[i] = tmp[x[i]];
    }
    bool operator< (const Item &O) const {
        for (int i = 0; i < HEIGHT + 1; i++) if (x[i] != O.x[i]) return x[i] < O.x[i];
        for (int i = 0; i < HEIGHT; i++) if (blue[i] != O.blue[i]) return blue[i] < O.blue[i];
        return dist < O.dist;
    }
    bool operator!= (const Item &O) const {
        for (int i = 0; i < HEIGHT + 1; i++) if (x[i] != O.x[i]) return true;
        for (int i = 0; i < HEIGHT; i++) if (blue[i] != O.blue[i]) return true;
        return false;
    }
    void shift() {
        for (int i = 0; i < HEIGHT; i++) x[i] = x[i + 1];
        for (int i = 0; i < HEIGHT - 1; i++) blue[i] = blue[i + 1];
    }
    int next() {
        return *max_element(x, x + HEIGHT + 1) + 1;
    }
};

struct ProfileDP {
    vector<Item> q;
    void normalize() {
        sort(q.begin(), q.end());
        vector<Item> p;
        for (auto &i: q) {
            if (p.empty() || p.back() != i) p.push_back(i);
            else if (p.back() < i) continue;
            else p.back().cnt = (p.back().cnt + i.cnt) % MOD;
        }
        q = p;
    }
    void init() {
        Item it;
        it.x[h - 1] = 1;
        q.push_back(it);
        it.x[h - 1] = 0;
        it.x[h] = 1;
        q.push_back(it);
    }
    void calc(int i, int j, char c) {
        vector<Item> p;
        for (auto &x: q) next(x, i, j, c, p);
        q = p;
    }
    void add_next(int x, int y, Item O, vector<Item> &v) {
        if (y == h - 1 && O.x[h]) return;
        v.push_back(O);
        v.back().normalize();
    }
    void add(Item O, int x, int y, int zero, int one, int visit, int blue, vector<Item> &v) {
        O.shift();
        O.x[h - 1] = zero;
        O.x[h] = one;
        O.dist += visit;
        O.blue[h - 1] = blue && visit;
        if (blue > 1) O.blue[h - 1] = 2;
        add_next(x, y, O, v);
    }
    void add_pink(Item O, int x, int y, vector<Item> &v) {
        if (O.x[0]) {
            if (O.x[h]) {
                if (O.x[0] == O.x[h]) {
                    bool er = true;
                    for (int i = 1; i < h; i++) if (O.x[i] == O.x[h]) er = false;
                    if (er) return;
                    add(O, x, y, 0, 0, 1, 0, v);
                } else {
                    for (int i = 1; i < h; i++) if (O.x[i] == O.x[0]) O.x[i] = O.x[h];
                    O.x[0] = O.x[h];
                    bool er = true;
                    for (int i = 1; i < h; i++) if (O.x[i] == O.x[h]) er = false;
                    if (er) return;
                    add(O, x, y, 0, 0, 1, 0, v);
                }
            } else {
                add(O, x, y, O.x[0], 0, 1, 0, v);
                add(O, x, y, 0, O.x[0], 1, 0, v);
            }
        } else {
            if (O.x[h]) {
                add(O, x, y, O.x[h], 0, 1, 0, v);
                add(O, x, y, 0, O.x[h], 1, 0, v);
            } else {
                add(O, x, y, 0, 0, 0, 0, v);
                add(O, x, y, O.next(), O.next(), 1, 0, v);
            }
        }
    }
    void add_red(Item O, int x, int y, vector<Item> &v) {
        if (O.x[0] || O.x[h]) return;
        add(O, x, y, 0, 0, 0, 0, v);
    }
    void add_yellow(Item O, int x, int y, vector<Item> &v) {
        if (O.x[0] || O.x[h]) return;
        if (O.blue[0] == 1 || (y != 0 && O.blue[h - 1] == 1)) return;
        add(O, x, y, 0, 0, 0, 2, v);
    }
    void add_blue(Item O, int x, int y, vector<Item> &v) {
        if (O.blue[0] == 2 || (y != 0 && O.blue[h - 1] == 2)) {
            if (O.x[0] || O.x[h]) return;
            add(O, x, y, 0, 0, 0, 1, v);
            return;
        }
        if (O.x[0]) {
            if (O.x[h]) {
                if (O.x[0] == O.x[h]) {
                    bool er = true;
                    for (int i = 1; i < h; i++) if (O.x[i] == O.x[h]) er = false;
                    if (er) return;
                    add(O, x, y, 0, 0, 1, 1, v);
                } else {
                    for (int i = 1; i < h; i++) if (O.x[i] == O.x[0]) O.x[i] = O.x[h];
                    O.x[0] = O.x[h];
                    bool er = true;
                    for (int i = 1; i < h; i++) if (O.x[i] == O.x[h]) er = false;
                    if (er) return;
                    add(O, x, y, 0, 0, 1, 1, v);
                }
            } else {
                add(O, x, y, O.x[0], 0, 1, 1, v);
                add(O, x, y, 0, O.x[0], 1, 1, v);
            }
        } else {
            if (O.x[h]) {
                add(O, x, y, O.x[h], 0, 1, 1, v);
                add(O, x, y, 0, O.x[h], 1, 1, v);
            } else {
                add(O, x, y, 0, 0, 0, 1, v);
                add(O, x, y, O.next(), O.next(), 1, 1, v);
            }
        }
    }
    void add_purple(Item O, int x, int y, vector<Item> &v) {
        if (O.x[0]) {
            if (O.x[h]) add(O, x, y, O.x[0], O.x[h], 2, 0, v);
            else add(O, x, y, O.x[0], 0, 1, 0, v);
        } else {
            if (O.x[h]) add(O, x, y, 0, O.x[h], 1, 0, v);
            else add(O, x, y, 0, 0, 0, 0, v);
        }
    }
    void next(Item O, int x, int y, char z, vector<Item> &v) {
        if (z == 'X') add_pink(O, x, y, v);
        if (z == 'R') add_red(O, x, y, v);
        if (z == 'B') add_blue(O, x, y, v);
        if (z == 'Y') add_yellow(O, x, y, v);
        if (z == 'P') add_purple(O, x, y, v);
        if (z == '?') {
            add_pink(O, x, y, v);
            add_red(O, x, y, v);
            add_blue(O, x, y, v);
            add_yellow(O, x, y, v);
            add_purple(O, x, y, v);
        }
    }
    void fine() {
        vector<Item> p;
        for (auto &i: q) {
            for (int j = 0; j < h + 1; j++) {
                if (i.x[j] && j != h - 1) goto next;
                if (!i.x[j] && j == h - 1) goto next;
            }
            p.push_back(i);
            next:;
        }
        q = p;
    }
} prof;

int main() {
    scanf("%d%d", &h, &w);
    for (int i = 0; i < h; i++) scanf("%s", str[i]);
    scanf("%d", &k);
    prof.init();
    for (int i = 0; i < w; i++) for (int j = 0; j < h; j++) {
        if (!i && !j) continue;
        prof.calc(i, j, str[j][i]);
        prof.normalize();
    }
    prof.fine();
    int e = min_element(prof.q.begin(), prof.q.end(), [](const Item &a, const Item &b) {
        return a.dist < b.dist;
    }) - prof.q.begin();
    int cnt = 0;
    for (auto &i: prof.q) if (i.dist == prof.q[e].dist) cnt = (cnt + i.cnt) % MOD;
    printf("%d", cnt);
}