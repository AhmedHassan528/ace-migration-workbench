/* Message flow / subflow parser (.msgflow, .subflow - XMI/EMF serialisation used by the ACE Toolkit).
 * Reads only what is actually in the file: nodes, their types, configured attributes, connections,
 * ESQL routine references, Java classes, subflow references and promoted properties. */
(function (ACE) {
  'use strict';
  var mf = ACE.msgflow = {};

  /* Friendly names for IBM built-in node types (xmi type prefix "ComIbmXxx.msgnode"). */
  mf.NODE_TYPES = {
    ComIbmSOAPInput: ['SOAP Input', 'soap'], ComIbmSOAPReply: ['SOAP Reply', 'soap'], ComIbmSOAPRequest: ['SOAP Request', 'soap'],
    ComIbmSOAPAsyncRequest: ['SOAP Async Request', 'soap'], ComIbmSOAPAsyncResponse: ['SOAP Async Response', 'soap'],
    ComIbmSOAPExtract: ['SOAP Extract', 'soap'], ComIbmSOAPEnvelope: ['SOAP Envelope', 'soap'],
    ComIbmWSInput: ['HTTP Input', 'http'], ComIbmWSReply: ['HTTP Reply', 'http'], ComIbmWSRequest: ['HTTP Request', 'http'],
    ComIbmHTTPAsyncRequest: ['HTTP Async Request', 'http'], ComIbmHTTPAsyncResponse: ['HTTP Async Response', 'http'],
    ComIbmHTTPHeader: ['HTTP Header', 'http'], ComIbmRESTRequest: ['REST Request', 'http'], ComIbmRESTAsyncRequest: ['REST Async Request', 'http'],
    ComIbmMQInput: ['MQ Input', 'mq'], ComIbmMQOutput: ['MQ Output', 'mq'], ComIbmMQReply: ['MQ Reply', 'mq'], ComIbmMQGet: ['MQ Get', 'mq'], ComIbmMQHeader: ['MQ Header', 'mq'],
    ComIbmJMSClientInput: ['JMS Input', 'jms'], ComIbmJMSClientOutput: ['JMS Output', 'jms'], ComIbmJMSClientReply: ['JMS Reply', 'jms'], ComIbmJMSClientReceive: ['JMS Receive', 'jms'], ComIbmJMSHeader: ['JMS Header', 'jms'],
    ComIbmCompute: ['Compute', 'transform'], ComIbmJavaCompute: ['JavaCompute', 'java'], ComIbmFilter: ['Filter', 'routing'],
    ComIbmDatabase: ['Database', 'database'], ComIbmDatabaseRetrieve: ['DatabaseRetrieve', 'database'], ComIbmDatabaseRoute: ['DatabaseRoute', 'database'],
    ComIbmDatabaseInput: ['DatabaseInput', 'database'], ComIbmDataInsert: ['DataInsert', 'database'], ComIbmDataUpdate: ['DataUpdate', 'database'], ComIbmDataDelete: ['DataDelete', 'database'], ComIbmWarehouse: ['Warehouse', 'database'],
    ComIbmMSLMapping: ['Mapping', 'transform'], ComIbmXslMqsi: ['XSL Transform', 'transform'], ComIbmMapping: ['Mapping (legacy)', 'transform'],
    ComIbmTrace: ['Trace', 'utility'], ComIbmThrow: ['Throw', 'error'], ComIbmTryCatch: ['TryCatch', 'error'], ComIbmFlowOrder: ['FlowOrder', 'routing'],
    ComIbmResetContentDescriptor: ['ResetContentDescriptor', 'utility'], ComIbmRoute: ['Route', 'routing'], ComIbmRouteToLabel: ['RouteToLabel', 'routing'], ComIbmLabel: ['Label', 'routing'],
    ComIbmPassthru: ['Passthrough', 'utility'], ComIbmValidate: ['Validate', 'utility'], ComIbmCollector: ['Collector', 'routing'],
    ComIbmAggregateControl: ['AggregateControl', 'routing'], ComIbmAggregateRequest: ['AggregateRequest', 'routing'], ComIbmAggregateReply: ['AggregateReply', 'routing'],
    ComIbmTimeoutControl: ['TimeoutControl', 'timer'], ComIbmTimeoutNotification: ['TimeoutNotification', 'timer'],
    ComIbmFileInput: ['File Input', 'file'], ComIbmFileOutput: ['File Output', 'file'], ComIbmFileRead: ['File Read', 'file'], ComIbmFTEInput: ['FTE Input', 'file'], ComIbmFTEOutput: ['FTE Output', 'file'],
    ComIbmEmailOutput: ['Email Output', 'email'], ComIbmEmailInput: ['Email Input', 'email'], ComIbmCORBARequest: ['CORBA Request', 'corba'],
    ComIbmTCPIPClientInput: ['TCPIP Client Input', 'tcpip'], ComIbmTCPIPClientOutput: ['TCPIP Client Output', 'tcpip'], ComIbmTCPIPServerInput: ['TCPIP Server Input', 'tcpip'], ComIbmTCPIPServerOutput: ['TCPIP Server Output', 'tcpip'],
    ComIbmSAPInput: ['SAP Input', 'adapter'], ComIbmSAPRequest: ['SAP Request', 'adapter'], ComIbmCDQ: ['CDQ', 'mq'], ComIbmSecurityPEP: ['SecurityPEP', 'security'],
    ComIbmMQTTPublish: ['MQTT Publish', 'mqtt'], ComIbmMQTTSubscribe: ['MQTT Subscribe', 'mqtt'], ComIbmKafkaProducer: ['Kafka Producer', 'kafka'], ComIbmKafkaConsumer: ['Kafka Consumer', 'kafka'], ComIbmKafkaRead: ['Kafka Read', 'kafka'],
    ComIbmGroupScatter: ['Group Scatter', 'routing'], ComIbmGroupGather: ['Group Gather', 'routing'], ComIbmGroupComplete: ['Group Complete', 'routing'],
    ComIbmSCAInput: ['SCA Input', 'sca'], ComIbmSCARequest: ['SCA Request', 'sca'], ComIbmSCAReply: ['SCA Reply', 'sca'],
    ComIbmDecisionService: ['Decision Service', 'rules'], ComIbmSalesforceRequest: ['Salesforce Request', 'adapter'], ComIbmODMRules: ['ODM Rules', 'rules'],
    ComIbmJSONSchemaValidate: ['JSON Validate', 'utility'], ComIbmLoopback: ['LoopBack Request', 'adapter']
  };

  var ESQL_ATTRS = /^(computeExpression|filterExpression|statement|expression)$/;
  var ESQL_REF = /^esql:\/\/routine\/([^#]*)#(.+?)(?:\.(Main))?$/;

  function attrsOf(el) {
    var o = {};
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (/^xmi:/.test(a.name) || a.name === 'location') continue;
      if (/\.internal_npcompiler$/.test(a.name)) continue;
      o[a.name] = a.value;
    }
    return o;
  }

  function lineOf(text, needle) {
    var i = text.indexOf(needle);
    return i < 0 ? null : ACE.util.lineAt(text, i);
  }

  /* Parse a flow file. Returns {name, nodes[], connections[], esqlRefs[], javaClasses[], subflowRefs[], promoted[], errors[]} */
  mf.parse = function (text, vpath) {
    var res = { vpath: vpath, name: ACE.util.stripExt(vpath.split('!/').pop()), nodes: [], connections: [], esqlRefs: [], javaClasses: [], subflowRefs: [], promoted: [], userDefinedNodes: [], errors: [], namespaces: {} };
    var doc;
    try { doc = new DOMParser().parseFromString(text, 'application/xml'); }
    catch (e) { res.errors.push('XML parse failed: ' + e.message); return res; }
    var pe = doc.getElementsByTagName('parsererror');
    if (pe.length) { res.errors.push('XML is not well formed: ' + (pe[0].textContent || '').slice(0, 200)); return res; }
    var root = doc.documentElement;
    for (var i = 0; i < root.attributes.length; i++) {
      var a = root.attributes[i];
      if (a.name.indexOf('xmlns:') === 0) res.namespaces[a.name.slice(6)] = a.value;
    }
    // Promoted / flow-level properties
    Array.prototype.forEach.call(doc.getElementsByTagName('eStructuralFeatures'), function (sf) {
      res.promoted.push({ name: sf.getAttribute('name'), type: (sf.getAttribute('eType') || '').split('#').pop(), defaultValue: sf.getAttribute('defaultValueLiteral') });
    });
    var nodes = doc.getElementsByTagName('nodes');
    Array.prototype.forEach.call(nodes, function (n) {
      var xt = n.getAttribute('xmi:type') || '';
      var prefix = xt.split(':')[0];
      var nsUri = res.namespaces[prefix] || prefix;
      var label = '';
      var tr = n.getElementsByTagName('translation')[0];
      if (tr) label = tr.getAttribute('string') || tr.getAttribute('key') || '';
      var node = { id: n.getAttribute('xmi:id'), xmiType: xt, prefix: prefix, ns: nsUri, label: label, attrs: attrsOf(n), line: lineOf(text, 'xmi:id="' + n.getAttribute('xmi:id') + '"') };
      var m = /^(ComIbm[A-Za-z0-9]+)\.msgnode$/.exec(nsUri);
      if (m) {
        node.kind = 'builtin';
        node.type = m[1];
        var t = mf.NODE_TYPES[m[1]];
        node.typeLabel = t ? t[0] : m[1].replace(/^ComIbm/, '');
        node.family = t ? t[1] : 'other';
        node.known = !!t;
      } else if (/\.(subflow|msgflow)$/.test(nsUri)) {
        node.kind = 'subflow'; node.type = nsUri; node.typeLabel = 'Subflow: ' + ACE.util.stripExt(nsUri); node.family = 'subflow';
        res.subflowRefs.push({ nodeId: node.id, label: label, path: nsUri, line: node.line });
      } else if (/\.msgnode$/.test(nsUri)) {
        node.kind = 'udn'; node.type = nsUri; node.typeLabel = 'User-defined node: ' + nsUri.replace(/\.msgnode$/, ''); node.family = 'udn';
        res.userDefinedNodes.push({ nodeId: node.id, label: label, type: nsUri });
      } else { node.kind = 'other'; node.type = nsUri; node.typeLabel = nsUri; node.family = 'other'; }
      Object.keys(node.attrs).forEach(function (k) {
        var v = node.attrs[k];
        var em = ESQL_REF.exec(v);
        if (em && (ESQL_ATTRS.test(k) || node.kind === 'subflow' || /esql/.test(v))) {
          res.esqlRefs.push({ nodeId: node.id, nodeLabel: label, attr: k, schema: em[1] || '', module: em[2], ref: v, line: node.line });
        }
      });
      if (node.attrs.javaClass) res.javaClasses.push({ nodeId: node.id, nodeLabel: label, className: node.attrs.javaClass, line: node.line });
      res.nodes.push(node);
    });
    Array.prototype.forEach.call(doc.getElementsByTagName('connections'), function (c) {
      res.connections.push({ source: c.getAttribute('sourceNode'), target: c.getAttribute('targetNode'), sourceTerminal: (c.getAttribute('sourceTerminalName') || ''), targetTerminal: (c.getAttribute('targetTerminalName') || '') });
    });
    return res;
  };

  /* Short, report-friendly configuration summary for a node. */
  mf.keyConfig = function (node) {
    var keys = ['wsdlFileName', 'selectedOperation', 'selectedPortType', 'urlSelector', 'URLSpecifier', 'webServiceURL', 'useHTTPS', 'sslProtocol', 'allowedSSLCiphers', 'securityProfileName', 'policySetBindings', 'policySet', 'wsSecurityPolicyUrl', 'queueName', 'queueManagerName', 'connection', 'policyUrl', 'dataSource', 'javaClass', 'computeExpression', 'filterExpression', 'statement', 'messageDomainProperty', 'validateMaster', 'filePath', 'requestTimeout', 'timeoutForServer', 'transactionMode', 'mappingExpression'];
    var o = {};
    keys.forEach(function (k) { if (node.attrs[k] != null) o[k] = node.attrs[k]; });
    return o;
  };
})(window.ACE);
