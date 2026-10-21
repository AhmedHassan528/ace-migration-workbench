package corpus;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/* Decompiler test corpus: constructs the workbench decompiler is EXPECTED to report as not
 * (fully) supported - lambdas, inner and anonymous classes. The test checks that they are labelled
 * honestly (partial/failed with a reason), never silently faked. */
public class Unsupported {
  private int v = 3;

  class In { int get() { return v * 2; } }

  static int plain(int x) { return x * 2; }

  public static void main(String[] args) {
    List<String> l = new ArrayList<>(Arrays.asList("b", "a", "c"));
    l.sort((x, y) -> x.compareTo(y));
    Unsupported o = new Unsupported();
    System.out.println(l + " " + plain(4) + " " + o.new In().get() + " " + new Object() { public String toString() { return "anon"; } });
  }
}
