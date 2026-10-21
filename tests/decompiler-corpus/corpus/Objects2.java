package corpus;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/* Decompiler test corpus: objects, inheritance, generics, arrays, boxing. */
public class Objects2 {
  interface Shape { double area(); default String label() { return "shape:" + Math.round(area()); } }

  static abstract class Base implements Shape {
    protected final String name;
    Base(String n) { name = n; }
    public abstract double area();
    public String toString() { return name + "=" + label(); }
  }

  static class Rect extends Base {
    private final double w, h;
    Rect(double w, double h) { super("rect"); this.w = w; this.h = h; }
    Rect(double s) { this(s, s); }
    public double area() { return w * h; }
  }

  static class Circle extends Base {
    double r;
    Circle(double r) { super("circle"); this.r = r; }
    public double area() { return Math.PI * r * r; }
    @Override public String label() { return "round:" + super.label(); }
  }

  static <T extends Comparable<T>> T max(List<T> xs) { T best = null; for (T x : xs) if (best == null || x.compareTo(best) > 0) best = x; return best; }
  static int varargs(String sep, int... xs) { int s = 0; for (int x : xs) s += x; return s + sep.length(); }
  static Map<String, List<Integer>> group(int[] xs) {
    Map<String, List<Integer>> m = new TreeMap<>();
    for (int x : xs) { String k = x % 2 == 0 ? "even" : "odd"; List<Integer> l = m.get(k); if (l == null) { l = new ArrayList<>(); m.put(k, l); } l.add(x); }
    return m;
  }
  static String arrays() {
    int[][] g = new int[3][4]; g[1][2] = 7; long[] ls = {1L, 2L}; Object[] os = new String[]{"x", null}; char[] cs = "hey".toCharArray();
    return g[1][2] + ":" + g.length + ":" + g[0].length + ":" + ls[1] + ":" + os.length + ":" + new String(cs) + ":" + (os instanceof String[]);
  }
  static Object castBox(Object o) { if (o instanceof Integer) return ((Integer) o) + 1; if (o instanceof String && !((String) o).isEmpty()) return ((String) o).charAt(0); return null; }

  public static void main(String[] args) {
    List<Shape> shapes = new ArrayList<>(Arrays.asList(new Rect(2, 3), new Rect(4), new Circle(1)));
    for (Shape s : shapes) System.out.println(s);
    System.out.println(max(Arrays.asList(3, 9, 2)) + " " + max(Arrays.asList("b", "a")) + " " + varargs("--", 1, 2, 3) + " " + varargs(""));
    System.out.println(group(new int[]{1, 2, 3, 4, 5}) + " " + arrays() + " " + castBox(41) + castBox("zed") + castBox(""));
    Integer boxed = 127; int un = boxed + 1; Long lg = 5L;
    System.out.println(un + lg + " " + (boxed == 127));
  }
}
