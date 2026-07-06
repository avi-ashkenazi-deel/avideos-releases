// JavaScript Document by avi asheknazi


$(document).ready(function() {
    $("#mySlider").royalSlider({
        captionShowEffects:["moveleft", "fade"],
        directionNavAutoHide: true,
		controlNavEnabled: false,
		keyboardNavEnabled:true,  
		controlNavigation: 'none',
		imageScaleMode:'fill',
		loop:true,          
        /* other options go here, view javascript options to learn more */	
		beforeLoadStart:function() {					
				$("p.navId").text((this.currentSlideId+1) + "/"  +   (this.numSlides) );
		
			},
			beforeSlideChange:function() {					
				$("p.navId").text((this.currentSlideId+1) + "/"  +   (this.numSlides) );
			}		
    });  
});

