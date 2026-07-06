// JavaScript Document by avi asheknazi
$(document).ready(function(){
	$("#projects").children().mouseover(function(){
		$(this).find(".thumb_image").fadeIn("fast");
		$(this).find(".thumb_image").css("display","block");
		$(this).find("p").css("display","none");
		$(this).find("h2").css("display","none");
});
$("#projects").children().mouseout(function(){
		$(this).find(".thumb_image").css("display","none");
		$(this).find("p").css("display","block");
		$(this).find("h2").css("display","block");
});
	
	function leaveMenu(){
		$("#menu_dare_head").css("color","black");
		$("#menu_items_head").css("color","black");
	};
});
//$("#"+$(this).attr("id")+" img:first")