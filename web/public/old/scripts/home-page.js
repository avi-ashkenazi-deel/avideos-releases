// JavaScript Document by avi asheknazi
$(document).ready(function(){
	$("#projects").children().mouseover(function(){
		$(this).find(".thumb-image").fadeIn("fast");
		$(this).find(".thumb-image").css("display","block");
		$(this).find("p").css("display","none");
		$(this).find("h2").css("display","none");
});
$("#projects").children().mouseout(function(){
		$(this).find(".thumb-image").css("display","none");
		$(this).find("p").css("display","block");
		$(this).find("h2").css("display","block");
});
	
	function leaveMenu(){
		$("#menu-dare-head").css("color","black");
		$("#menu-items-head").css("color","black");
	};
});
//$("#"+$(this).attr("id")+" img:first")