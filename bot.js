var http=require('http'), url=require('url'), colors=require('colors');

function MediaWikiSetting(obj){
	//setting object
	this.hostname=obj.hostname || "localhost";
}
MediaWikiSetting.prototype.getObj=function(path,method){
	//obj for http.get
	var u=url.parse(path);
	return {
		hostname:u.hostname || this.hostname,
		protocol: u.protocol || "http:",
		port:u.port || 80,
		path:u.path,
		method:method|| "GET",
	};
};
function DeleterBot(setting){
	this.setting=setting;	//MediaWikiSetting
	if(!(setting instanceof MediaWikiSetting)){
		throw new Error("Invalid setting obj");
	}
	this.cookies={};	//Cookie
	//deleteトークンを取得しておく
	this.deleteToken=null;
}
//setting
DeleterBot.prototype.bot_english_percentage=65;	//削除閾値

DeleterBot.prototype.request=function(method,path,body,callback){
	var pathobj=this.setting.getObj(path,method);
	//cookie追加
	var ck=Object.keys(this.cookies);
	if(ck.length>0){
		//
		var cookieHeader=ck.map(function(key){
			return key+"="+this.cookies[key];
		},this).join("; ");
		pathobj.headers={
			"Cookie": cookieHeader,
		};
	}
	var req=http.request(pathobj,function(res){
		var status=res.statusCode;
		this.log(String(status).green,path.grey);
		if(status===301 || status===302 || status===303 || status===307){
			//redirect
			this.get(res.headers.location,callback);
			abort();
			return;
		}
		if(status>=400){
			//あれれーーーー
			this.gotError(new Error("aborted."));
			abort();
			return;
		}
		//まずtypeを解析
		var type=res.headers["content-type"];
		var typeres=type.match(/^\s*([-\w]+)\/([-\w]+)\s*(?:;\s*(\S*))?/);
		if(!typeres){
			this.gotError(new Error("Unknown content-type: "+type));
			abort();
			return;
		}
		//受け付けられないやつ
		if(typeres[1]!=="text"){
			if(typeres[1]!=="application" || (typeres[2]!=="json" && typeres[2]!=="xml")){
				//json,xml以外はダメ
				this.gotError(new Error("Unacceptable content-type:"+type));
				abort();
				return;
			}
		}
		//charsetを解析
		var charset="utf8";	//default
		if(typeres[3]){
			//parameter
			var typeres2=typeres[3].match(/charset\s*=\s*([^\s;]+)/i);
			if(typeres2){
				//指定あった
				if(/utf-?8/i.test(typeres2[1])){
					charst="utf8";
				}else{
					this.gotError(new Error("unacceptable charset:"+type));
					abort();
					return;
				}
			}
		}
		res.setEncoding(charset);

		var data="";	//貯める
		res.on("data",function(chunk){
			data+=chunk;
		});
		if("function"===typeof callback){
			//res: Response
			res.on("end",function(){
				callback(data);
			});
		}
		//cookieの処理
		var c=res.headers["set-cookie"];
		if(Array.isArray(c)){
			//肝心部分のみ
			c.forEach(function(str){
				var result=str.match(/^([-\w]+)\s*=\s*([^\s;]+)/);
				if(result){
					this.setCookie(result[1],result[2]);
				}
			},this);
		}
		//リクエスト終了処理
		function abort(){
			delete callback;
			res.destroy();
		}
	}.bind(this));
	//クッキー
	if(body){
		req.write(body);
	}	
	req.end();
	req.on("error",function(e){
		this.gotError(e);
		delete callback;
		req.abort();
	}.bind(this));
};
DeleterBot.prototype.postGetJSON=function(path,body,callback){
	this.request("POST",path,body,function(res){
		//json化
		try{
			var obj=JSON.parse(res);
		}catch(e){
			bot.log(res.slice(0,1024*2));
			this.gotError(e);
		}
		callback(obj);
	}.bind(this));
};

//エラーに出会った
DeleterBot.prototype.gotError=function(e){
	console.error('error:',e.message);
};
//クッキーを設定する
DeleterBot.prototype.setCookie=function(key,value){
	this.cookies[key]=value;
};
//ログ
DeleterBot.prototype.log=function(){
	if(argv.nocolor){
		//color符号削除
		for(var i=0,l=arguments.length;i<l;i++){
			arguments[i]=arguments[i].replace(/\u001b\[\w\w\w/g,"");
		}
	}
	if(!argv.silent){
		console.log.apply(console,arguments);
	}
};
//-----------------------------------------
//Mediawikiに対する処理
//apiに投げる
DeleterBot.prototype.api=function(getobj,postobj,cb){
	//クエリはオブジェクトで表現
	getobj.format="json";
	this.postGetJSON("/api.php?"+objQuerify(getobj),objQuerify(postobj),cb);
	function objQuerify(obj){
		var keys=Object.keys(obj);
		var query=keys.map(function(x){
			return x+"="+encodeURIComponent(obj[x]);
		}).join("&");
		return query;
	}
};
//ログインする
DeleterBot.prototype.login=function(name,password,cb){
	this.api({
		action:"login",
		lgname:name,
		lgpassword:password,
	},{
	},function handler(result){
		if(result.login.result==="NeedToken"){
			//トークンが無かった（セット済み）　もう一回
			this.api({
				action:"login",
				lgname:name,
				lgpassword:password,
				lgtoken: result.login.token,
			},{},handler.bind(this));
		}else if(result.login.result==="Success"){
			//成功した クッキーをセット
			var cookieprefix=result.login.cookieprefix;
			this.setCookie(cookieprefix+"UserName",result.login.lgusername);
			this.setCookie(cookieprefix+"UserID",result.login.lguserid);
			this.setCookie(cookieprefix+"Token",result.login.lgtoken);
			
			//deleteトークンを取得
			this.api({
				action:"query",
				prop:"info",
				intoken:"delete",
				titles:"メインページ",
			},{},function(result){
				this.deleteToken=result.query.pages[1].deletetoken;
				//cb();
				//次に標識を確認（可動許可がでているか）
				this.pageContent("利用者:"+name,function(cont){
					//標識を探す
					if(!cont){
						console.error("利用者:"+name+" is not available");
						return;
					}
					var result=cont.match(/BOT\s*:\s*(\S+)/);
					if(!result){
						console.error("no 標識 was found. not working");
						return;
					}
					if(result[1]!=="稼働"){
						console.error("標識 says "+result[0]+". not working");
						return;
					}
					//OK!
					cb();
				});
			}.bind(this));
		}else{
			//不測の事態
			console.error(result);
			this.gotError(new Error("Cannot login"));
		}
	}.bind(this));
};
//リスト取得クエリ(パラメータをobjで渡す）(paramに対して破壊的) listtype:"recentchanges"とか number:取得ページ数
//イテレータ関数を返す
DeleterBot.prototype.eachlist=function(param,listtype,number,cb){
	param.action="query";
	param.list=listtype;
	//ページストア
	var pages=[], count=0;
	//次のリクエストオブジェクト
	var nextparam=param;	//1回目は引数通り

	var t=this;
	return function iterate(cb){
		if(count>=number){
			//もういっぱいだ
			cb(null);
			return;
		}
		if(pages.length>0){
			//返す
			cb(pages.shift());
			return;
		}	
		//もうないけど継続したい
		if(!nextparam){
			//継続できない
			cb(null);
			return;
		}
		this.api(nextparam,{},function handler(result){
			//ページを取得した
			var qco=result["query-continue"];
			var qcon=qco ? qco[listtype] : null;	//継続用オブジェクト
			if(qcon){
				//次回のリクエスト準備
				nextparam={};
				for(var key in param){
					nextparam[key]=param[key];
				}
				//qconので上書き
				for(var key in qcon){
					nextparam[key]=qcon[key];
				}
			}else{
				//もう終了
				nextparam=null;
			}
			//ページ追加
			pages=pages.concat(result.query[listtype]);
			iterate(cb);
		});
	}.bind(this);
};
//ページ取得クエリ
DeleterBot.prototype.query=function(param,prop,cb){
	param.action="query";
	param.prop=prop;

	this.api(param,{},function(result){
		cb(result.query);
	});
};
//ページ削除クエリ
DeleterBot.prototype.deletePage=function(title,cb){
	this.api({
		action:"delete",
		title:title,
		token:this.deleteToken,
		reason:"spam",
	},{},function(result){
		//console.log(result);
		bot.log("delete".red,title);
		cb();
	});
};
//ページの内容を取得
DeleterBot.prototype.pageContent=function(title,cb){
	this.query({
		rvprop:"ids|content",
		titles:title,
	},"revisions",function(result){
		//目的のページ
		for(var key in result.pages){
			//最初のやつ(1つしかない)
			var pagedata=result.pages[key];
			if(pagedata.missing!=null || !pagedata.revisions){
				this.log("warn ".yellow,("'"+pagedata.title+"'").cyan,"doesn't exist");
				cb(null);
			}else{
				var revdata=pagedata.revisions[0];
				var content=revdata["*"];
				cb(content);
			}
			return;
		}
	}.bind(this));
};

//応用的: ページ名からそのページの英字含有率取得
DeleterBot.prototype.englishRate=function(title,cb){
	this.pageContent(title,function(content){
		//英字含有率計算
		if(!content){
			//計算できない
			cb(Number.NaN);
			return;
		}
		var full=content.length;
		//英字除去
		var remains=content.replace(/(?:-|\w)/g,"").length;
		var english_rate=(full-remains)/full;
		cb(english_rate);
		return;
	});
};
//-----------------------------
//get argv
var argv=process.argv.slice(2);
//method set this[flagname] to true/false;
argv.setFlag=function(flagname){
	//arguments: param to find!(or)
	this[flagname]= Array.prototype.slice.call(arguments,1).some.call(arguments,function(x){
		return this.indexOf(x)>=0;
	},this);
};
argv.setFlag("help","-h","--help");
argv.setFlag("silent","-s","--silent");
argv.setFlag("nocolor","-c","--nocolor");
argv.setFlag("dry","-d","--dry");

//help mode
if(argv.help){
	console.log(["commandline params:",
			"\t-h, --help: show this message",
			"\t-s, --silent: no debug log",
			"\t-nc, --nocolor: non-coloured log",
			"\t-d, --dry: dry run(no delete)",
			].join("\n"));
			process.exit();
}
// perform
var setting=new MediaWikiSetting({
	hostname:"some-mediawiki.org",
});
var bot=new DeleterBot(setting);

bot.login("username","password",function(){
	//ログインしたら最新の変更をチェック
	var deletecount=0;
	var iterator=bot.eachlist({
		rctype:"new",
		rcshow:"!bot",
		rcprop:"user|title|ids|flags",
	},"recentchanges",100);
	iterator(function handle(page){
		//page: ひとつのページの情報
		if(page==null){
			bot.log((deletecount?deletecount:"no"),"pages are deleted.");
			return;	//終わり
		}
		//新規作成ページ（怪しい）
		if(page.type==="new"){
			bot.englishRate(page.title,function(rate){
				var rateStr=(rate*100).toPrecision(3)+"%";
				if(rate*100 >= bot.bot_english_percentage){
					bot.log(page.title,rateStr.red);
					//削除レートである
					if(!argv.dry){
						//本番
						bot.deletePage(page.title,function(){
							//次へ
							iterator(handle);
						});
						deletecount++;
					}else{
						iterator(handle);
					}
				}else{
					bot.log(page.title,rateStr.blue);
					//次へ
					iterator(handle);
				}
			});
		}
		return true;
	});
});
