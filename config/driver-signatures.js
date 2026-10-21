/* Known JDBC driver signatures used to classify JARs. Editable: add entries for in-house drivers.
 * Detection never relies on the filename alone - package names, the java.sql.Driver service
 * registration and manifest attributes carry more weight (see js/java/jar-analyzer.js). */
window.ACE_DRIVER_SIGNATURES = [
  { id: 'mssql', name: 'Microsoft SQL Server JDBC Driver', packages: ['com/microsoft/sqlserver/jdbc/'], driverClasses: ['com.microsoft.sqlserver.jdbc.SQLServerDriver'], filePatterns: ['^mssql-jdbc', '^sqljdbc'], manifest: ['Microsoft JDBC Driver', 'Microsoft SQL Server'] },
  { id: 'jtds', name: 'jTDS (SQL Server / Sybase)', packages: ['net/sourceforge/jtds/'], driverClasses: ['net.sourceforge.jtds.jdbc.Driver'], filePatterns: ['^jtds'], manifest: ['jTDS'] },
  { id: 'mysql', name: 'MySQL Connector/J', packages: ['com/mysql/jdbc/', 'com/mysql/cj/jdbc/'], driverClasses: ['com.mysql.jdbc.Driver', 'com.mysql.cj.jdbc.Driver'], filePatterns: ['^mysql-connector'], manifest: ['MySQL Connector', 'Connector/J'] },
  { id: 'mariadb', name: 'MariaDB Connector/J', packages: ['org/mariadb/jdbc/'], driverClasses: ['org.mariadb.jdbc.Driver'], filePatterns: ['^mariadb-java-client'], manifest: ['MariaDB'] },
  { id: 'oracle', name: 'Oracle JDBC Driver', packages: ['oracle/jdbc/'], driverClasses: ['oracle.jdbc.OracleDriver', 'oracle.jdbc.driver.OracleDriver'], filePatterns: ['^ojdbc', '^classes12'], manifest: ['Oracle JDBC'] },
  { id: 'db2', name: 'IBM Data Server Driver for JDBC (DB2 JCC)', packages: ['com/ibm/db2/jcc/'], driverClasses: ['com.ibm.db2.jcc.DB2Driver'], filePatterns: ['^db2jcc'], manifest: ['IBM Data Server Driver', 'DB2 JDBC'] },
  { id: 'informix', name: 'IBM Informix JDBC Driver', packages: ['com/informix/jdbc/'], driverClasses: ['com.informix.jdbc.IfxDriver'], filePatterns: ['^ifxjdbc', '^jdbc-.*informix'], manifest: ['Informix'] },
  { id: 'datadirect', name: 'IBM/Progress DataDirect JDBC', packages: ['com/ddtek/jdbc/', 'com/ibm/jdbc/'], driverClasses: [], filePatterns: ['^ibm?sqlserver', '^ibm?oracle', '^ib?sybase'], manifest: ['DataDirect'] },
  { id: 'postgresql', name: 'PostgreSQL JDBC Driver', packages: ['org/postgresql/'], driverClasses: ['org.postgresql.Driver'], filePatterns: ['^postgresql'], manifest: ['PostgreSQL JDBC'] },
  { id: 'sybase', name: 'Sybase jConnect', packages: ['com/sybase/jdbc2/', 'com/sybase/jdbc3/', 'com/sybase/jdbc4/', 'com/sybase/jdbcx/'], driverClasses: ['com.sybase.jdbc2.jdbc.SybDriver', 'com.sybase.jdbc3.jdbc.SybDriver', 'com.sybase.jdbc4.jdbc.SybDriver'], filePatterns: ['^jconn'], manifest: ['jConnect', 'Sybase'] },
  { id: 'teradata', name: 'Teradata JDBC Driver', packages: ['com/teradata/jdbc/'], driverClasses: ['com.teradata.jdbc.TeraDriver'], filePatterns: ['^terajdbc'], manifest: ['Teradata'] },
  { id: 'h2', name: 'H2 Database', packages: ['org/h2/'], driverClasses: ['org.h2.Driver'], filePatterns: ['^h2-'], manifest: ['H2 Database'] },
  { id: 'derby', name: 'Apache Derby', packages: ['org/apache/derby/'], driverClasses: ['org.apache.derby.jdbc.EmbeddedDriver', 'org.apache.derby.jdbc.ClientDriver'], filePatterns: ['^derby'], manifest: ['Apache Derby'] },
  { id: 'sqlite', name: 'SQLite JDBC', packages: ['org/sqlite/'], driverClasses: ['org.sqlite.JDBC'], filePatterns: ['^sqlite-jdbc'], manifest: ['SQLite JDBC'] },
  { id: 'hsqldb', name: 'HSQLDB', packages: ['org/hsqldb/'], driverClasses: ['org.hsqldb.jdbc.JDBCDriver', 'org.hsqldb.jdbcDriver'], filePatterns: ['^hsqldb'], manifest: ['HSQLDB'] }
];

/* Package prefixes of well-known third-party / product libraries. JARs made mostly of these are
 * classified "third-party" and are not selected for decompilation by default (user can include). */
window.ACE_THIRD_PARTY_PREFIXES = [
  'org/apache/', 'com/fasterxml/', 'com/google/', 'org/slf4j/', 'ch/qos/logback/', 'org/springframework/',
  'org/json/', 'com/sun/', 'javax/', 'jakarta/', 'org/bouncycastle/', 'org/w3c/', 'org/xml/', 'io/netty/',
  'org/codehaus/', 'org/yaml/', 'net/minidev/', 'com/jayway/', 'org/eclipse/', 'org/glassfish/', 'okhttp3/',
  'com/squareup/', 'org/joda/', 'org/hibernate/', 'com/ibm/mq/', 'com/ibm/msg/client/', 'com/ibm/jms/'
];

/* IBM ACE product API packages: JARs consisting of these are product files, never decompiled. */
window.ACE_PRODUCT_PREFIXES = ['com/ibm/broker/', 'com/ibm/etools/', 'com/ibm/integration/'];
