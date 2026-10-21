import java.security.*; import javax.crypto.*; import javax.crypto.spec.*; import java.io.*;
public class B64 {
  static String legacy(byte[] data){ java.util.Base64.Encoder enc=java.util.Base64.getEncoder(); String sep=System.lineSeparator(); StringBuilder sb=new StringBuilder(); for(int off=0;off<data.length;off+=57){int len=Math.min(57,data.length-off); sb.append(enc.encodeToString(java.util.Arrays.copyOfRange(data,off,off+len))); if(len==57) sb.append(sep);} return sb.toString(); }
  public static void main(String[] a) throws Exception {
    String mode=a[0];
    if(mode.equals("b64")){ java.util.Random r=new java.util.Random(42); int bad=0,n=0; for(int len=0;len<=1200;len++){ byte[] b=new byte[len]; r.nextBytes(b); String x=new com.ibm.misc.BASE64Encoder().encode(b); String y=legacy(b); n++; if(!x.equals(y)){ bad++; if(bad<4) System.out.println("MISMATCH len="+len+" ibm=["+x.replace("\r","\r").replace("\n","\n")+"] mine=["+y.replace("\r","\r").replace("\n","\n")+"]"); } } System.out.println("b64 compared="+n+" mismatches="+bad); return; }
    if(mode.equals("mkks")){ KeyStore ks=KeyStore.getInstance("JCEKS"); ks.load(null,null); SecretKey k=new SecretKeySpec(new byte[]{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24},"DESede"); ks.setEntry("k1",new KeyStore.SecretKeyEntry(k),new KeyStore.PasswordProtection("pw".toCharArray())); try(FileOutputStream f=new FileOutputStream("ibm.jceks")){ks.store(f,"pw".toCharArray());} System.out.println("keystore written by "+ks.getProvider()); }
    KeyStore ks=KeyStore.getInstance("JCEKS"); try(FileInputStream f=new FileInputStream("ibm.jceks")){ks.load(f,"pw".toCharArray());} Key key=ks.getKey("k1","pw".toCharArray()); System.out.println("loaded key alg="+key.getAlgorithm()+" via "+ks.getProvider());
    Cipher c = mode.equals("mkks") ? Cipher.getInstance("TripleDES/ECB/PKCS5Padding","IBMJCE") : Cipher.getInstance("TripleDES/ECB/PKCS5Padding");
    c.init(Cipher.ENCRYPT_MODE,key); System.out.println("cipher provider="+c.getProvider()+" ct="+java.util.Base64.getEncoder().encodeToString(c.doFinal("Hello ACE migration 0123456789".getBytes("UTF-8"))));
  }
}
