package corpus;

/* Decompiler test corpus (written for this project; free to redistribute).
 * Each class prints deterministic output; the test compares the output of the original
 * bytecode with the output of the decompiled-and-recompiled source. */
public class Arith {
  static int counter = 3;
  long big = 1L << 40;
  static final double PI2 = Math.PI * 2;

  static int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }

  static long mix(int a, long b, float c, double d, short s, byte by, char ch) {
    long r = a * 31 + b; r ^= (long) (c * 100); r += (long) d >> 2; r -= s % 7; r |= by & 0xF; r = r * ch + (r >>> 3); return r;
  }

  static String classify(int x) { if (x < 0) return "neg"; else if (x == 0) return "zero"; else if (x < 10) return "small"; return "big"; }
  static boolean even(int x) { return x % 2 == 0; }
  static boolean between(int x, int lo, int hi) { return x >= lo && x <= hi; }
  static boolean outside(int x, int lo, int hi) { return x < lo || x > hi; }
  static int complexCond(int a, int b, boolean f) { if ((a > b && f) || (a == b && !f) || a < 0) return 1; return 2; }
  static int ternaryNest(int a) { return a > 10 ? (a > 100 ? 3 : 2) : (a < 0 ? -1 : 1); }
  static double fl(double a, float b) { if (a < b) return a / b; if (!(a >= b)) return -1; return a * b; }
  static int incs(int[] arr) { int i = 0, s = 0; arr[i++] = 5; arr[i++] = 6; s += arr[--i]; s += i++ + ++i; return s * 10 + i; }
  static int sumArr(int[][] m) { int s = 0; for (int[] row : m) for (int v : row) s += v; return s; }

  static String chars(String s) {
    StringBuilder b = new StringBuilder();
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c >= 'a' && c <= 'z') b.append((char) (c - 32)); else if (c == ' ') b.append('_'); else b.append(c);
    }
    return b.toString();
  }

  public static void main(String[] args) {
    System.out.println(fib(15) + " " + mix(7, 9L, 1.5f, 3.75, (short) 13, (byte) -3, 'Q'));
    for (int x : new int[]{-5, 0, 3, 42}) System.out.println(x + ":" + classify(x) + ":" + even(x) + ":" + between(x, 0, 10) + ":" + outside(x, 0, 10) + ":" + ternaryNest(x * 7));
    System.out.println(complexCond(3, 2, true) + "" + complexCond(2, 2, false) + complexCond(1, 2, true) + complexCond(-1, 5, true));
    System.out.println(fl(1.0, 2f) + " " + fl(Double.NaN, 1f) + " " + fl(3.0, 2f));
    System.out.println(incs(new int[4]) + " " + sumArr(new int[][]{{1, 2}, {3}, {}}) + " " + chars("hello World 9"));
    Arith a = new Arith();
    a.big += counter++;
    System.out.println(a.big + " " + counter + " " + PI2 + " " + Long.MIN_VALUE + " " + Integer.MIN_VALUE + " " + Float.MIN_VALUE + " " + 1e-7 + " " + (0.1f + 0.2f) + " " + Double.MAX_VALUE + " " + (int) (char) 7 + "|" + "\t\"q\"\\" + '\'');
  }
}
