package corpus;

import java.util.Arrays;
import java.util.List;

/* Decompiler test corpus: control flow. */
public class Flow {
  static String sw(int x) {
    switch (x) {
      case 1: return "one";
      case 2: case 3: return "two-three";
      case 10: x += 5;
      case 11: return "ten-eleven:" + x;
      default: return "other";
    }
  }
  static int sw2(char c) { int r = 0; switch (c) { case 'a': r = 1; break; case 'b': r = 2; break; case 'z': r = 26; break; default: r = -1; } return r; }
  static int sparse(int k) { switch (k) { case -1000: return 1; case 7: return 2; case 1000000: return 3; } return 0; }
  static String strSwitch(String s) { switch (s) { case "alpha": return "A"; case "beta": return "B"; default: return "?"; } }
  static int loops(int n) {
    int s = 0;
    outer:
    for (int i = 0; i < n; i++) {
      for (int j = 0; j < n; j++) {
        if (j > i) continue outer;
        if (i * j > 20) break outer;
        s += i * j;
      }
    }
    return s;
  }
  static int whileDo(int n) { int c = 0; while (n > 1) { n = n % 2 == 0 ? n / 2 : 3 * n + 1; c++; } int d = 0; do { d++; } while (d < 3); return c * 10 + d; }
  static int earlyExit(List<Integer> xs) { int s = 0; for (Integer x : xs) { if (x == null) continue; if (x < 0) return -s; s += x; } return s; }
  static String tries(String s) {
    StringBuilder log = new StringBuilder();
    try { log.append("a"); Integer.parseInt(s); log.append("b"); }
    catch (NumberFormatException e) { log.append("nfe"); }
    catch (RuntimeException e) { log.append("rt"); }
    try {
      try { if (s.length() > 3) throw new IllegalStateException("long"); log.append("c"); }
      catch (IllegalStateException e) { log.append("ise:" + e.getMessage()); throw new RuntimeException("wrapped", e); }
    } catch (RuntimeException e) { log.append("|" + e.getMessage()); }
    return log.toString();
  }
  static int finallyBlock(int x) { int r = 0; try { r = 10 / x; } catch (ArithmeticException e) { r = -1; } finally { r += 100; } return r; }
  static synchronized int syncMethod(int x) { return x + 1; }
  static int syncBlock(Object lock, int x) { synchronized (lock) { return x * 3; } }
  static int nestedTern(boolean a, boolean b) { return a ? b ? 1 : 2 : b ? 3 : 4; }
  static boolean boolLogic(boolean a, boolean b, boolean c) { boolean r = a & b | c ^ a; r = r && !c || (a != b); return r; }
  static int multiCatch(Object o) {
    try { String s = (String) o; return s.length() / (s.length() - 3); }
    catch (ClassCastException | ArithmeticException e) { return e instanceof ArithmeticException ? -2 : -1; }
    catch (NullPointerException e) { return -3; }
  }
  public static void main(String[] args) {
    for (int i : new int[]{1, 2, 3, 10, 11, 99}) System.out.print(sw(i) + ",");
    System.out.println(sw2('a') + "," + sw2('z') + "," + sw2('q') + "," + sparse(7) + sparse(1000000) + sparse(-1000) + sparse(5) + strSwitch("beta") + strSwitch("x"));
    System.out.println(loops(8) + " " + whileDo(27) + " " + earlyExit(Arrays.asList(1, null, 2, 3)) + " " + earlyExit(Arrays.asList(4, -1, 9)));
    System.out.println(tries("12") + " " + tries("xyz") + " " + tries("12345") + " " + finallyBlock(5) + " " + finallyBlock(0) + " " + syncMethod(4) + " " + syncBlock("L", 5));
    System.out.println(nestedTern(true, false) + "" + nestedTern(false, true) + boolLogic(true, false, true) + boolLogic(false, false, false) + multiCatch("abcdef") + multiCatch(5) + multiCatch("abc") + multiCatch(null));
  }
}
