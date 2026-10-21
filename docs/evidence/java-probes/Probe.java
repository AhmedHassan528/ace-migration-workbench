import java.security.*;
import javax.crypto.*;
import javax.net.ssl.*;
public class Probe {
  public static void main(String[] a) throws Exception {
    System.out.println("java.version=" + System.getProperty("java.version") + " vendor=" + System.getProperty("java.vendor"));
    for (String p : new String[]{"IBMJCE","IBMJCEPlus","IBMJCEPlusFIPS","SunJCE","IBMJSSE2","SunJSSE","OpenJCEPlus"}) System.out.println("provider " + p + " = " + (Security.getProvider(p) != null));
    try { Cipher c = Cipher.getInstance("TripleDES/ECB/PKCS5Padding", "IBMJCE"); System.out.println("TripleDES via IBMJCE OK: " + c.getProvider()); } catch (Exception e) { System.out.println("TripleDES via IBMJCE FAIL: " + e); }
    try { Cipher c = Cipher.getInstance("TripleDES/ECB/PKCS5Padding"); System.out.println("TripleDES default OK: " + c.getProvider()); } catch (Exception e) { System.out.println("TripleDES default FAIL: " + e); }
    try { KeyStore k = KeyStore.getInstance("JCEKS"); System.out.println("JCEKS OK: " + k.getProvider()); } catch (Exception e) { System.out.println("JCEKS FAIL: " + e); }
    for (String p : new String[]{"TLS","SSL","SSL_TLS","SSL_TLSv2","TLSv1","TLSv1.2","TLSv1.3"}) { try { SSLContext s = SSLContext.getInstance(p); s.init(null,null,null); System.out.println("SSLContext " + p + " OK " + s.getProvider() + " defaultProtocols=" + String.join(",", s.getDefaultSSLParameters().getProtocols())); } catch (Exception e) { System.out.println("SSLContext " + p + " FAIL " + e); } }
    try { Class.forName("com.ibm.misc.BASE64Encoder"); System.out.println("com.ibm.misc.BASE64Encoder present (reflection)"); } catch (Throwable e) { System.out.println("com.ibm.misc.BASE64Encoder: " + e); }
    try { Class.forName("sun.misc.BASE64Encoder"); System.out.println("sun.misc.BASE64Encoder present"); } catch (Throwable e) { System.out.println("sun.misc.BASE64Encoder: " + e); }
    System.out.println("jdk.tls.disabledAlgorithms=" + Security.getProperty("jdk.tls.disabledAlgorithms"));
  }
}
