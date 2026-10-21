import javax.crypto.*; import javax.crypto.spec.*;
public class C3 { public static void main(String[] a) throws Exception {
  SecretKey k=new SecretKeySpec(new byte[]{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24},"DESede");
  Cipher c=Cipher.getInstance("TripleDES/ECB/PKCS5Padding"); c.init(Cipher.ENCRYPT_MODE,k);
  System.out.println(System.getProperty("java.version")+" "+c.getProvider()+" ct="+java.util.Base64.getEncoder().encodeToString(c.doFinal("Hello ACE migration 0123456789".getBytes("UTF-8"))));
  try { String s = new String(java.util.Base64.getEncoder().encode(new byte[]{1})); javax.crypto.SecretKeyFactory.getInstance("DESede"); System.out.println("SecretKeyFactory DESede OK"); } catch(Exception e){System.out.println(e);} } }
